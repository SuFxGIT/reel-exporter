import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { config, hls as H } from "../config.js"
import { logger } from "../logger.js"
import { exists, sleep, waitFor } from "../util/async.js"
import {
  killProcess,
  lineSplitter,
  parseProgressLine,
  pauseProcess,
  resumeProcess,
  spawnFfmpeg,
  type RegisteredProcess,
} from "./ffmpeg.js"
import { colorTagArgs, inputArgs, previewFilters } from "./filters.js"
import type { ProbeResult } from "./probe.js"

const SEG = H.segmentSeconds
const log = logger.child({ mod: "hls" })

export class HlsError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface Run {
  seq: number
  dir: string
  startIdx: number
  entry: RegisteredProcess
  state: "starting" | "running" | "paused" | "exited"
  /** Highest segment index written by this run (startIdx - 1 before the first one). */
  lastProducedIdx: number
  outTimeUs: number
  lastProgressAt: number
  exitCode: number | null
  poller: NodeJS.Timeout | null
  stderrTail: string[]
}

export interface Session {
  key: string
  itemId: string
  audioIdx: number
  absPath: string
  probe: ProbeResult
  dir: string
  segmentCount: number
  /** idx -> absolute segment file (may live in any run directory). */
  segments: Map<number, string>
  bytesOnDisk: number
  initBuf: Buffer | null
  run: Run | null
  runSeq: number
  lastRequestedIdx: number
  lastAccess: number
  restartLock: Promise<void> | null
}

const pad5 = (n: number): string => String(n).padStart(5, "0")
const segName = (idx: number): string => `seg${pad5(idx)}.m4s`
const SEG_RE = /^seg(\d{5})\.m4s$/

export function segmentCountFor(duration: number): number {
  if (!(duration > 0)) return 0
  const n = Math.floor(duration / SEG) + (duration % SEG >= 0.5 ? 1 : 0)
  return Math.max(1, n)
}

function buildArgs(s: Session, startIdx: number, dir: string): string[] {
  const p = s.probe
  const t = startIdx * SEG
  const audio = s.audioIdx >= 0 && s.audioIdx < p.audio.length
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "warning",
    "-nostats",
    "-progress",
    "pipe:1",
    "-stats_period",
    "0.5",
    "-threads",
    "8",
    ...inputArgs(p),
  ]
  if (startIdx > 0) args.push("-ss", t.toFixed(3))
  args.push("-i", s.absPath)
  if (p.hasVideo) args.push("-map", "0:V:0")
  if (audio) args.push("-map", `0:a:${s.audioIdx}`)
  args.push("-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1")
  if (p.hasVideo) {
    args.push(
      "-filter_threads",
      "4",
      "-vf",
      previewFilters(p),
      "-fps_mode:v",
      "vfr",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-threads:v",
      "8",
      "-force_key_frames",
      `expr:gte(t,n_forced*${SEG})`,
      "-forced-idr",
      "1",
      "-sc_threshold",
      "0",
      ...colorTagArgs(p)
    )
  }
  if (audio)
    args.push("-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "160k")
  args.push(
    "-output_ts_offset",
    (t + H.tsPad).toFixed(3),
    "-f",
    "hls",
    "-hls_time",
    String(SEG),
    "-hls_playlist_type",
    "vod",
    "-hls_list_size",
    "0",
    "-start_number",
    String(startIdx),
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    path.join(dir, "seg%05d.m4s"),
    "-hls_flags",
    "independent_segments+temp_file",
    "-hls_segment_options",
    "movflags=+frag_discont+negative_cts_offsets+skip_sidx:use_editlist=0",
    "-y",
    path.join(dir, "stream.m3u8")
  )
  return args
}

/** Checks that a buffer is a complete `ftyp` + `moov` init segment. */
function validInitSegment(buf: Buffer): boolean {
  let off = 0
  const types: string[] = []
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off)
    const type = buf.toString("latin1", off + 4, off + 8)
    if (size === 1 && off + 16 <= buf.length)
      size = Number(buf.readBigUInt64BE(off + 8))
    if (size < 8) return false
    types.push(type)
    off += size
  }
  return off === buf.length && types.includes("ftyp") && types.includes("moov")
}

class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private sweeper: NodeJS.Timeout | null = null

  start(): void {
    this.sweeper = setInterval(() => void this.sweep(), 10_000)
    this.sweeper.unref()
  }

  stats(): { sessions: number; activeRuns: number } {
    let activeRuns = 0
    for (const s of this.sessions.values())
      if (s.run && s.run.state !== "exited") activeRuns++
    return { sessions: this.sessions.size, activeRuns }
  }

  async getOrCreate(
    itemId: string,
    audioIdx: number,
    absPath: string,
    probe: ProbeResult
  ): Promise<Session> {
    const key = `${itemId}:a${audioIdx}`
    let s = this.sessions.get(key)
    if (s) {
      this.touch(s)
      return s
    }
    const segmentCount = segmentCountFor(probe.duration)
    if (segmentCount === 0)
      throw new HlsError(
        422,
        "This file has no known duration, so it cannot be streamed."
      )
    s = {
      key,
      itemId,
      audioIdx,
      absPath,
      probe,
      dir: path.join(
        config.transcodeDir,
        createHash("sha1").update(key).digest("hex").slice(0, 10)
      ),
      segmentCount,
      segments: new Map(),
      bytesOnDisk: 0,
      initBuf: null,
      run: null,
      runSeq: 0,
      lastRequestedIdx: -1,
      lastAccess: Date.now(),
      restartLock: null,
    }
    await fs.mkdir(s.dir, { recursive: true })
    this.sessions.set(key, s)
    await this.evictSessions()
    return s
  }

  private touch(s: Session): void {
    s.lastAccess = Date.now()
    // Map insertion order doubles as LRU order.
    this.sessions.delete(s.key)
    this.sessions.set(s.key, s)
  }

  playlist(s: Session): string {
    const n = s.segmentCount
    const d = s.probe.duration
    const lastDur = Math.max(0.5, d - SEG * (n - 1))
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(SEG, lastDur))}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      '#EXT-X-MAP:URI="init.mp4"',
    ]
    for (let i = 0; i < n; i++) {
      lines.push(
        `#EXTINF:${(i < n - 1 ? SEG : lastDur).toFixed(6)},`,
        segName(i)
      )
    }
    lines.push("#EXT-X-ENDLIST", "")
    return lines.join("\n")
  }

  async getInit(s: Session): Promise<Buffer> {
    if (s.initBuf) return s.initBuf
    this.touch(s)
    let run = s.run
    if (!run || run.state === "exited") {
      await this.restartAt(s, Math.max(0, s.lastRequestedIdx))
      run = s.run!
    }
    const initFile = path.join(run.dir, "init.mp4")
    const firstSeg = path.join(run.dir, segName(run.startIdx))
    await waitFor(
      async () => (await exists(firstSeg)) && (await exists(initFile)),
      {
        intervalMs: 100,
        timeoutMs: H.segmentWaitMs,
        abort: () => this.abortReason(s, run!, Date.now()),
      }
    ).catch((err) => {
      throw new HlsError(
        504,
        `Transcoder did not produce the init segment: ${(err as Error).message}`
      )
    })
    const buf = await fs.readFile(initFile)
    if (!validInitSegment(buf))
      throw new HlsError(500, "Transcoder produced an invalid init segment.")
    s.initBuf = buf
    return buf
  }

  /** Resolves to the absolute path of a finished segment file. */
  async getSegment(s: Session, idx: number): Promise<string> {
    if (!Number.isInteger(idx) || idx < 0 || idx >= s.segmentCount)
      throw new HlsError(404, "Segment out of range.")
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.getSegmentOnce(s, idx)
      } catch (err) {
        if ((err as Error).message === "restarted" && attempt < 2) continue
        if (err instanceof HlsError) throw err
        throw new HlsError(
          504,
          `Transcoder did not produce segment ${idx}: ${(err as Error).message}`
        )
      }
    }
    throw new HlsError(503, "Transcoder is busy, seek again.")
  }

  private async getSegmentOnce(s: Session, idx: number): Promise<string> {
    s.lastRequestedIdx = idx
    this.touch(s)
    const existing = s.segments.get(idx)
    if (existing) {
      if (s.run) this.applyThrottle(s, s.run)
      return existing
    }
    const run = s.run
    if (run && run.state !== "exited") {
      const next = run.lastProducedIdx + 1
      if (idx >= run.startIdx && idx >= next && idx <= next + H.waitWindow) {
        if (run.state === "paused") {
          resumeProcess(run.entry)
          run.state = "running"
          run.lastProgressAt = Date.now()
        }
        return this.waitForSegment(s, run, idx)
      }
    } else if (
      run &&
      run.exitCode === 0 &&
      idx >= run.startIdx &&
      idx > run.lastProducedIdx
    ) {
      throw new HlsError(404, "Segment is past the end of the stream.")
    }
    await this.restartAt(s, idx)
    return this.waitForSegment(s, s.run!, idx)
  }

  private abortReason(s: Session, run: Run, startedAt: number): string | null {
    if (s.run !== run) return "restarted"
    if (run.state === "exited") {
      if (run.exitCode === 0) return "past end of stream"
      return `transcoder exited (${run.exitCode ?? "killed"}) ${run.stderrTail.slice(-2).join(" | ")}`.trim()
    }
    if (
      run.state === "running" &&
      Date.now() - run.lastProgressAt > H.stallMs &&
      Date.now() - startedAt > H.stallMs
    ) {
      return "transcoder stalled"
    }
    return null
  }

  private async waitForSegment(
    s: Session,
    run: Run,
    idx: number
  ): Promise<string> {
    const file = path.join(run.dir, segName(idx))
    const startedAt = Date.now()
    try {
      return await waitFor(
        async () => {
          const known = s.segments.get(idx)
          if (known) return known
          if (await exists(file)) {
            this.registerSegment(s, run, idx, file)
            return file
          }
          return null
        },
        {
          intervalMs: 100,
          timeoutMs: H.segmentWaitMs,
          abort: () => this.abortReason(s, run, startedAt),
        }
      )
    } catch (err) {
      const msg = (err as Error).message
      if (msg === "restarted") throw err
      if (msg === "past end of stream")
        throw new HlsError(404, "Segment is past the end of the stream.")
      if (msg === "transcoder stalled") {
        log.warn(
          { item: s.itemId, idx },
          "hls: transcoder stalled, killing run"
        )
        await this.killRun(s, run)
      }
      throw err
    }
  }

  private registerSegment(
    s: Session,
    run: Run,
    idx: number,
    file: string
  ): void {
    if (!s.segments.has(idx)) {
      s.segments.set(idx, file)
      fs.stat(file)
        .then((st) => {
          s.bytesOnDisk += st.size
        })
        .catch(() => undefined)
    }
    if (idx > run.lastProducedIdx) run.lastProducedIdx = idx
    if (run.state === "starting") {
      run.state = "running"
      run.lastProgressAt = Date.now()
    }
  }

  private async pollRun(s: Session, run: Run): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(run.dir)
    } catch {
      return
    }
    for (const n of names) {
      const m = SEG_RE.exec(n)
      if (!m) continue
      this.registerSegment(s, run, Number(m[1]), path.join(run.dir, n))
    }
    this.applyThrottle(s, run)
  }

  private applyThrottle(s: Session, run: Run): void {
    if (run.state !== "running" && run.state !== "paused") return
    const ahead = run.lastProducedIdx - Math.max(0, s.lastRequestedIdx)
    if (run.state === "running" && ahead > H.aheadPause) {
      pauseProcess(run.entry)
      run.state = "paused"
    } else if (run.state === "paused" && ahead <= H.aheadResume) {
      resumeProcess(run.entry)
      run.state = "running"
      run.lastProgressAt = Date.now()
    }
  }

  private async restartAt(s: Session, idx: number): Promise<void> {
    while (s.restartLock) await s.restartLock
    let release!: () => void
    s.restartLock = new Promise<void>((r) => (release = r))
    try {
      const run = s.run
      if (run && run.state !== "exited") {
        const next = run.lastProducedIdx + 1
        if (
          idx >= run.startIdx &&
          idx >= next - 1 &&
          idx <= next + H.waitWindow
        )
          return // a sibling request already restarted here
        await this.killRun(s, run)
      }
      await this.enforceActiveRuns(s)
      await this.startRun(s, idx)
    } finally {
      s.restartLock = null
      release()
    }
  }

  private async enforceActiveRuns(current: Session): Promise<void> {
    const active = [...this.sessions.values()].filter(
      (x) => x !== current && x.run && x.run.state !== "exited"
    )
    while (active.length >= H.maxActiveRuns) {
      const victim = active.shift()!
      log.info(
        { item: victim.itemId },
        "hls: too many active transcodes, stopping least recently used"
      )
      await this.killRun(victim, victim.run!)
    }
  }

  private async startRun(s: Session, startIdx: number): Promise<Run> {
    s.runSeq += 1
    const dir = path.join(s.dir, `r${s.runSeq}`)
    await fs.mkdir(dir, { recursive: true })
    const args = buildArgs(s, startIdx, dir)
    const entry = spawnFfmpeg(args, { kind: `hls:${s.itemId}` })
    const run: Run = {
      seq: s.runSeq,
      dir,
      startIdx,
      entry,
      state: "starting",
      lastProducedIdx: startIdx - 1,
      outTimeUs: 0,
      lastProgressAt: Date.now(),
      exitCode: null,
      poller: null,
      stderrTail: [],
    }
    entry.proc.stdout?.on(
      "data",
      lineSplitter((line) => {
        const p = parseProgressLine(line)
        if (p?.key === "out_time_us") {
          run.outTimeUs = Number(p.value)
          run.lastProgressAt = Date.now()
        }
      })
    )
    entry.proc.stderr?.on(
      "data",
      lineSplitter((line) => {
        if (!line.trim()) return
        run.stderrTail.push(line)
        if (run.stderrTail.length > 20) run.stderrTail.shift()
        log.debug({ item: s.itemId, run: run.seq }, line)
      })
    )
    entry.proc.once("exit", (code, signal) => {
      run.state = "exited"
      run.exitCode = code
      if (run.poller) clearInterval(run.poller)
      run.poller = null
      void this.pollRun(s, run)
      if (code !== 0 && code !== null) {
        log.warn(
          {
            item: s.itemId,
            run: run.seq,
            code,
            tail: run.stderrTail.slice(-3),
          },
          "hls: ffmpeg exited with error"
        )
      } else {
        log.debug(
          { item: s.itemId, run: run.seq, code, signal },
          "hls: run ended"
        )
      }
    })
    run.poller = setInterval(() => void this.pollRun(s, run), 250)
    s.run = run
    log.info(
      {
        item: s.itemId,
        audio: s.audioIdx,
        run: run.seq,
        startIdx,
        t: startIdx * SEG,
      },
      "hls: transcode started"
    )
    return run
  }

  private async killRun(s: Session, run: Run): Promise<void> {
    if (run.poller) clearInterval(run.poller)
    run.poller = null
    if (run.state !== "exited") {
      await killProcess(run.entry)
      run.state = "exited"
    }
    // Drop partial files left behind by the kill.
    try {
      for (const n of await fs.readdir(run.dir)) {
        if (n.endsWith(".tmp"))
          await fs.unlink(path.join(run.dir, n)).catch(() => undefined)
      }
    } catch {
      /* dir gone */
    }
  }

  /** Drops a session and its files (client is done with this item/audio track). */
  async release(itemId: string, audioIdx: number): Promise<void> {
    const s = this.sessions.get(`${itemId}:a${audioIdx}`)
    if (s) await this.removeSession(s)
  }

  /** Stops the transcoder for a session but keeps its files for reuse. */
  async stopSession(s: Session): Promise<void> {
    if (s.run && s.run.state !== "exited") await this.killRun(s, s.run)
  }

  async removeSession(s: Session): Promise<void> {
    await this.stopSession(s)
    this.sessions.delete(s.key)
    await fs.rm(s.dir, { recursive: true, force: true }).catch(() => undefined)
    log.debug({ item: s.itemId, audio: s.audioIdx }, "hls: session removed")
  }

  private async evictSessions(): Promise<void> {
    const list = [...this.sessions.values()]
    while (list.length > H.maxSessions) {
      const victim = list.shift()!
      await this.removeSession(victim)
    }
    let total = 0
    for (const s of this.sessions.values()) total += s.bytesOnDisk
    const byAge = [...this.sessions.values()]
    while (total > config.transcodeMaxBytes && byAge.length > 1) {
      const victim = byAge.shift()!
      total -= victim.bytesOnDisk
      await this.removeSession(victim)
    }
  }

  private async trimSession(s: Session): Promise<void> {
    if (s.segments.size <= H.maxSegmentsPerSession) return
    const anchor = Math.max(0, s.lastRequestedIdx)
    const far = [...s.segments.keys()]
      .filter((i) => Math.abs(i - anchor) > 10)
      .sort((a, b) => Math.abs(b - anchor) - Math.abs(a - anchor))
    const excess = s.segments.size - H.maxSegmentsPerSession
    for (const idx of far.slice(0, excess)) {
      const file = s.segments.get(idx)!
      s.segments.delete(idx)
      const st = await fs.stat(file).catch(() => null)
      if (st) s.bytesOnDisk = Math.max(0, s.bytesOnDisk - st.size)
      await fs.unlink(file).catch(() => undefined)
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now()
    for (const s of [...this.sessions.values()]) {
      if (
        s.run &&
        s.run.state !== "exited" &&
        now - s.lastAccess > H.idleKillMs
      ) {
        log.info({ item: s.itemId }, "hls: idle, stopping transcoder")
        await this.stopSession(s)
      }
      if (now - s.lastAccess > 30 * 60_000) {
        await this.removeSession(s)
        continue
      }
      await this.trimSession(s)
    }
    await this.evictSessions()
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    for (const s of [...this.sessions.values()]) await this.removeSession(s)
  }
}

export const hlsSessions = new SessionManager()

/** Removes leftover transcode directories from a previous process. */
export async function cleanTranscodeDir(): Promise<void> {
  await fs.mkdir(config.transcodeDir, { recursive: true })
  const entries = await fs
    .readdir(config.transcodeDir)
    .catch(() => [] as string[])
  await Promise.all(
    entries.map((e) =>
      fs.rm(path.join(config.transcodeDir, e), { recursive: true, force: true })
    )
  )
  await sleep(0)
}

import { promises as fs } from "node:fs"
import { randomBytes } from "node:crypto"
import PQueue from "p-queue"
import type { PlayableInfo } from "../library/store.js"
import { logger } from "../logger.js"
import {
  allocateNumbered,
  captureUrls,
  fileVersion,
  releaseCapture,
  type CaptureTarget,
} from "./capture.js"
import {
  exited,
  killProcess,
  lineSplitter,
  parseProgressLine,
  spawnFfmpeg,
  type RegisteredProcess,
} from "./ffmpeg.js"
import { detectBars } from "./bars.js"
import {
  GIF_PALETTE,
  GIF_PALETTEUSE,
  colorTagArgs,
  fullResFilters,
  gifFilters,
  inputArgs,
  frameFilters,
  type Crop,
  type FrameAspect,
  type FrameBackground,
} from "./filters.js"
import type { ProbeResult } from "./probe.js"

export type { FrameAspect, FrameBackground } from "./filters.js"

/** Output aspect for a video export: the source picture, or a fixed frame. */
export type ExportAspect = "source" | FrameAspect

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled"

export type ClipQuality = "high" | "balanced" | "small"

export type ExportFormat = "mp4" | "gif"

/** GIFs grow fast; keep them short. */
export const GIF_MAX_SECONDS = 30

interface ExportBase {
  start: number
  end: number
  /** Audio stream index, or -1 for no audio. Always -1 for GIFs. */
  audio: number
  quality: ClipQuality
}

export type ExportParams =
  | (ExportBase & {
      format: "mp4"
      /** "source" keeps the picture's own aspect; anything else is a fixed frame. */
      aspect: ExportAspect
      /** Source aspect only: downscale so the width is at most this many pixels. */
      maxWidth?: number
      /** Fixed aspects only: short side of the output; omit to crop at native resolution. */
      shortSide?: number
      /** Fixed aspects only: what fills the frame around the picture. */
      background: FrameBackground
      /** Detect and drop black bars baked into the picture. */
      trimBars: boolean
      /** Fixed aspects only: window position, 0..1 from the left/top. */
      focus?: { x: number; y: number }
      /** Fixed aspects only: 1 covers the frame; above crops tighter, below shows the background. */
      zoom?: number
      /** Fixed aspects only: horizontal squeeze or stretch; 1 is the real width. */
      widthScale?: number
    })
  | (ExportBase & { format: "gif"; fps: number; width: number })

/** Kept as "clip" for MP4 so existing clients keep working. */
export type JobType = "clip" | "gif"

export const jobTypeFor = (format: ExportFormat): JobType =>
  format === "mp4" ? "clip" : format

const QUALITY: Record<ClipQuality, { crf: string; preset: string }> = {
  high: { crf: "18", preset: "medium" },
  balanced: { crf: "20", preset: "medium" },
  small: { crf: "24", preset: "fast" },
}

export interface Job {
  id: string
  type: JobType
  itemId: string
  status: JobStatus
  progress: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  params: ExportParams
  output?: {
    relPath: string
    name: string
    size: number
    url: string
    thumbUrl: string
    downloadUrl: string
  }
  error?: string
}

interface Internal {
  job: Job
  info: PlayableInfo
  probe: ProbeResult
  entry: RegisteredProcess | null
  target: CaptureTarget | null
  cancelled: boolean
}

const log = logger.child({ mod: "jobs" })
const KEEP_MS = 60 * 60_000

export const outputExt = (format: ExportFormat): "mp4" | "gif" =>
  format === "gif" ? "gif" : "mp4"

/** The palette written by the first GIF pass, next to the temp output. */
export const palettePathFor = (tmp: string): string => `${tmp}.palette.png`

/**
 * Common input arguments. `-t` sits before `-i` so it limits how much of the
 * source is read: as an output option it would only cap the file being written,
 * and with a second input (the GIF palette) it would apply to that input instead.
 */
function head(absPath: string, probe: ProbeResult, params: ExportBase) {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-nostats",
    "-y",
    "-progress",
    "pipe:1",
    "-stats_period",
    "0.5",
    "-threads",
    "8",
    ...inputArgs(probe),
    "-ss",
    params.start.toFixed(3),
    "-t",
    (params.end - params.start).toFixed(3),
    "-i",
    absPath,
  ]
}

/** Exact output length, applied after every input has been declared. */
const durationArgs = (params: ExportBase): string[] => [
  "-t",
  (params.end - params.start).toFixed(3),
]

function x264Args(probe: ProbeResult, quality: ClipQuality): string[] {
  const q = QUALITY[quality] ?? QUALITY.balanced
  return [
    "-c:v",
    "libx264",
    "-preset",
    q.preset,
    "-crf",
    q.crf,
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-threads:v",
    "12",
    ...colorTagArgs(probe),
  ]
}

const AAC_ARGS = ["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"]
const MP4_TAIL = ["-avoid_negative_ts", "make_zero", "-movflags", "+faststart"]

/**
 * ffmpeg arguments for one export pass. GIFs take two passes: the first writes
 * a palette next to `tmp`, the second encodes with it.
 */
export function exportArgs(
  absPath: string,
  probe: ProbeResult,
  params: ExportParams,
  tmp: string,
  pass: 1 | 2 = 1,
  extra: { bars?: Crop } = {}
): string[] {
  const args = head(absPath, probe, params)
  const hasAudio =
    params.format !== "gif" &&
    params.audio >= 0 &&
    params.audio < probe.audio.length
  switch (params.format) {
    case "gif": {
      const chain = gifFilters(probe, { fps: params.fps, width: params.width })
      if (pass === 1) {
        args.push(
          "-map",
          "0:V:0",
          "-an",
          "-sn",
          "-dn",
          "-filter_threads",
          "4",
          "-vf",
          `${chain},${GIF_PALETTE}`,
          "-frames:v",
          "1",
          "-update",
          "1",
          "-f",
          "image2",
          palettePathFor(tmp)
        )
      } else {
        args.push(
          "-i",
          palettePathFor(tmp),
          "-filter_complex",
          `[0:V:0]${chain}[x];[x][1:v]${GIF_PALETTEUSE}`,
          ...durationArgs(params),
          "-an",
          "-sn",
          "-dn",
          "-map_metadata",
          "-1",
          "-loop",
          "0",
          "-f",
          "gif",
          tmp
        )
      }
      return args
    }
    default: {
      if (probe.hasVideo) args.push("-map", "0:V:0")
      if (hasAudio) args.push("-map", `0:a:${params.audio}`)
      args.push("-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1")
      if (probe.hasVideo)
        args.push(
          "-filter_threads",
          "4",
          "-vf",
          params.aspect === "source"
            ? fullResFilters(
                probe,
                "yuv420p",
                "field",
                params.maxWidth,
                extra.bars
              )
            : frameFilters(probe, {
                aspect: params.aspect,
                background: params.background,
                ...(params.shortSide ? { shortSide: params.shortSide } : {}),
                ...(extra.bars ? { bars: extra.bars } : {}),
                ...(params.focus ? { focus: params.focus } : {}),
                ...(params.zoom ? { zoom: params.zoom } : {}),
                ...(params.widthScale ? { widthScale: params.widthScale } : {}),
              }),
          ...x264Args(probe, params.quality)
        )
      if (hasAudio) args.push(...AAC_ARGS)
      args.push(...durationArgs(params), ...MP4_TAIL, "-f", "mp4", tmp)
      return args
    }
  }
}

class JobManager {
  private readonly jobs = new Map<string, Internal>()
  private readonly queue = new PQueue({ concurrency: 1 })
  private sweeper: NodeJS.Timeout | null = null

  start(): void {
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
  }

  get(id: string): Job | null {
    return this.jobs.get(id)?.job ?? null
  }

  list(itemId?: string): Job[] {
    return [...this.jobs.values()]
      .map((j) => j.job)
      .filter((j) => !itemId || j.itemId === itemId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  running(): number {
    return [...this.jobs.values()].filter(
      (j) => j.job.status === "queued" || j.job.status === "running"
    ).length
  }

  createExport(
    info: PlayableInfo,
    probe: ProbeResult,
    params: ExportParams
  ): Job {
    const id = `job_${randomBytes(6).toString("base64url")}`
    const job: Job = {
      id,
      type: jobTypeFor(params.format),
      itemId: info.item.id,
      status: "queued",
      progress: 0,
      createdAt: new Date().toISOString(),
      params,
    }
    const internal: Internal = {
      job,
      info,
      probe,
      entry: null,
      target: null,
      cancelled: false,
    }
    this.jobs.set(id, internal)
    void this.queue.add(() => this.runExport(internal))
    return job
  }

  async cancel(id: string): Promise<boolean> {
    const internal = this.jobs.get(id)
    if (!internal) return false
    const { job } = internal
    if (job.status !== "queued" && job.status !== "running") return false
    internal.cancelled = true
    if (internal.entry) await killProcess(internal.entry)
    job.status = "cancelled"
    job.finishedAt = new Date().toISOString()
    return true
  }

  /** Runs one ffmpeg pass, mapping its progress onto [from, to] of the job. */
  private async runPass(
    internal: Internal,
    args: string[],
    from: number,
    to: number
  ): Promise<{ code: number | null; stderr: string[] }> {
    const { job } = internal
    const duration = job.params.end - job.params.start
    const entry = spawnFfmpeg(args, { kind: `export:${job.id}`, nice: 10 })
    internal.entry = entry
    const stderr: string[] = []
    entry.proc.stdout?.on(
      "data",
      lineSplitter((line) => {
        const p = parseProgressLine(line)
        if (p?.key === "out_time_us") {
          const us = Number(p.value)
          if (Number.isFinite(us) && duration > 0) {
            const frac = Math.min(1, us / (duration * 1e6))
            job.progress = Math.min(
              0.99,
              Math.max(job.progress, from + (to - from) * frac)
            )
          }
        }
      })
    )
    entry.proc.stderr?.on(
      "data",
      lineSplitter((line) => {
        if (line.trim()) stderr.push(line)
        if (stderr.length > 30) stderr.shift()
      })
    )
    const code = await exited(entry.proc)
    internal.entry = null
    return { code, stderr }
  }

  private async runExport(internal: Internal): Promise<void> {
    const { job, info, probe } = internal
    if (internal.cancelled) return
    job.status = "running"
    job.startedAt = new Date().toISOString()
    const { params } = job
    const duration = params.end - params.start
    const ext = outputExt(params.format)
    let target: CaptureTarget | null = null
    let tmp: string | null = null
    try {
      target = await allocateNumbered(info, ext)
      internal.target = target
      tmp = `${target.absPath}.tmp.${ext}`
      // Video: find baked-in black bars first so the placement works on the picture.
      let bars: Crop | null = null
      if (params.format === "mp4" && params.trimBars && probe.hasVideo) {
        bars = await detectBars(
          info.absPath,
          probe,
          params.start,
          params.end
        ).catch((err: Error) => {
          log.warn({ job: job.id, err: err.message }, "bar detection failed")
          return null
        })
        if (internal.cancelled) return
      }
      const extra = bars ? { bars } : {}
      const passes: Array<[string[], number, number]> =
        params.format === "gif"
          ? [
              [exportArgs(info.absPath, probe, params, tmp, 1), 0, 0.5],
              [exportArgs(info.absPath, probe, params, tmp, 2), 0.5, 0.99],
            ]
          : [[exportArgs(info.absPath, probe, params, tmp, 1, extra), 0, 0.99]]
      for (const [args, from, to] of passes) {
        const { code, stderr } = await this.runPass(internal, args, from, to)
        if (internal.cancelled) return
        if (code !== 0)
          throw new Error(
            `ffmpeg failed (exit ${code ?? "killed"}): ${stderr.slice(-3).join(" | ") || "no details"}`
          )
      }
      const st = await fs.stat(tmp).catch(() => null)
      if (!st || st.size === 0)
        throw new Error("ffmpeg wrote an empty file. Check the container logs.")
      await fs.rename(tmp, target.absPath)
      const done = await fs.stat(target.absPath).catch(() => st)
      job.progress = 1
      job.status = "done"
      job.output = {
        relPath: target.relPath,
        name: target.name,
        size: st.size,
        ...captureUrls(target.relPath, fileVersion(done)),
      }
      log.info(
        {
          job: job.id,
          type: job.type,
          file: target.relPath,
          seconds: duration,
          ms: Date.now() - Date.parse(job.startedAt),
        },
        "export saved"
      )
    } catch (err) {
      if (!internal.cancelled) {
        job.status = "failed"
        job.error = (err as Error).message
        log.warn(
          { job: job.id, type: job.type, err: job.error },
          "export failed"
        )
      }
    } finally {
      job.finishedAt = new Date().toISOString()
      if (tmp) {
        if (job.status !== "done") await fs.unlink(tmp).catch(() => undefined)
        await fs.unlink(palettePathFor(tmp)).catch(() => undefined)
      }
      if (target) releaseCapture(target)
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - KEEP_MS
    for (const [id, j] of this.jobs) {
      if (j.job.finishedAt && Date.parse(j.job.finishedAt) < cutoff)
        this.jobs.delete(id)
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    for (const j of this.jobs.values()) {
      if (j.job.status === "running" || j.job.status === "queued")
        await this.cancel(j.job.id)
    }
  }
}

export const jobs = new JobManager()

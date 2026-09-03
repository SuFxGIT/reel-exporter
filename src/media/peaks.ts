import path from "node:path"
import { LRUCache } from "lru-cache"
import PQueue from "p-queue"
import { config } from "../config.js"
import { logger } from "../logger.js"
import { atomicWriteJson, readJson } from "../util/async.js"
import { exited, lineSplitter, spawnFfmpeg } from "./ffmpeg.js"
import { inputArgs } from "./filters.js"
import type { ProbeResult } from "./probe.js"

export interface PeaksData {
  version: 1
  duration: number
  peaksPerSecond: number
  count: number
  /** Loudest bucket, 0..255. Clients divide by this to normalise. */
  maxPeak: number
  /** Base64 of one byte per bucket (0..255). */
  peaks: string
}

export type PeaksState =
  | { status: "ready"; data: PeaksData }
  | { status: "pending" }
  | { status: "failed"; error: string }

const SAMPLE_RATE = 8000
const PEAKS_PER_SECOND = 4
const BUCKET = SAMPLE_RATE / PEAKS_PER_SECOND

const log = logger.child({ mod: "peaks" })
const memory = new LRUCache<string, PeaksData>({ max: 50 })
const queue = new PQueue({ concurrency: 1 })
const inFlight = new Set<string>()
const failures = new Map<string, { at: number; error: string }>()

const cacheFile = (key: string): string =>
  path.join(config.cacheDir, "peaks", `${key}.json`)

export function emptyPeaks(duration: number): PeaksData {
  return {
    version: 1,
    duration,
    peaksPerSecond: PEAKS_PER_SECOND,
    count: 0,
    maxPeak: 0,
    peaks: "",
  }
}

async function generate(
  key: string,
  absPath: string,
  probe: ProbeResult,
  audioIdx: number
): Promise<PeaksData> {
  const stream = probe.audio[audioIdx]
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-threads",
    "2",
  ]
  if (stream && /^dts/.test(stream.codec)) args.push("-core_only", "1")
  args.push(...inputArgs(probe), "-discard:v", "all", "-i", absPath)
  args.push(
    "-map",
    `0:a:${audioIdx}`,
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1"
  )

  const entry = spawnFfmpeg(args, { kind: `peaks:${key}`, nice: 10 })
  const stderr: string[] = []
  entry.proc.stderr?.on(
    "data",
    lineSplitter((l) => stderr.push(l))
  )

  const peaks: number[] = []
  let bucketMax = 0
  let bucketCount = 0
  let carry: Buffer | null = null
  entry.proc.stdout?.on("data", (chunk: Buffer) => {
    let buf = carry ? Buffer.concat([carry, chunk]) : chunk
    const usable = buf.length - (buf.length % 2)
    carry = usable < buf.length ? buf.subarray(usable) : null
    buf = buf.subarray(0, usable)
    for (let i = 0; i < buf.length; i += 2) {
      const v = Math.abs(buf.readInt16LE(i))
      if (v > bucketMax) bucketMax = v
      if (++bucketCount === BUCKET) {
        peaks.push(Math.round((bucketMax / 32768) * 255))
        bucketMax = 0
        bucketCount = 0
      }
    }
  })
  const started = Date.now()
  const code = await exited(entry.proc)
  if (bucketCount > 0) peaks.push(Math.round((bucketMax / 32768) * 255))
  if (code !== 0)
    throw new Error(
      `ffmpeg exit ${code ?? "killed"}: ${stderr.slice(-2).join(" | ")}`
    )
  const bytes = Uint8Array.from(peaks)
  const data: PeaksData = {
    version: 1,
    duration: probe.duration,
    peaksPerSecond: PEAKS_PER_SECOND,
    count: bytes.length,
    maxPeak: bytes.reduce((m, v) => (v > m ? v : m), 0),
    peaks: Buffer.from(bytes).toString("base64"),
  }
  log.info(
    {
      key,
      seconds: Math.round(probe.duration),
      buckets: bytes.length,
      ms: Date.now() - started,
    },
    "peaks generated"
  )
  return data
}

/** Returns cached peaks, or schedules generation and reports pending. */
export async function getPeaks(
  id: string,
  absPath: string,
  probe: ProbeResult,
  audioIdx: number
): Promise<PeaksState> {
  if (audioIdx < 0 || audioIdx >= probe.audio.length)
    return { status: "ready", data: emptyPeaks(probe.duration) }
  const key = `${id}-a${audioIdx}`
  const mem = memory.get(key)
  if (mem) return { status: "ready", data: mem }
  const disk = await readJson<PeaksData>(cacheFile(key))
  if (disk && disk.version === 1 && typeof disk.peaks === "string") {
    memory.set(key, disk)
    return { status: "ready", data: disk }
  }
  const failed = failures.get(key)
  if (failed && Date.now() - failed.at < 60_000)
    return { status: "failed", error: failed.error }
  if (!inFlight.has(key)) {
    inFlight.add(key)
    void queue.add(async () => {
      try {
        const data = await generate(key, absPath, probe, audioIdx)
        memory.set(key, data)
        failures.delete(key)
        await atomicWriteJson(cacheFile(key), data).catch((err) =>
          log.warn({ err: (err as Error).message }, "peaks: cache write failed")
        )
      } catch (err) {
        failures.set(key, { at: Date.now(), error: (err as Error).message })
        log.warn(
          { key, err: (err as Error).message },
          "peaks: generation failed"
        )
      } finally {
        inFlight.delete(key)
      }
    })
  }
  return { status: "pending" }
}

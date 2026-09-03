import { promises as fs } from "node:fs"
import { LRUCache } from "lru-cache"
import PQueue from "p-queue"
import { lastLines, runFfmpeg } from "./ffmpeg.js"
import { inputArgs, thumbnailFilters } from "./filters.js"
import type { ProbeResult } from "./probe.js"

const cache = new LRUCache<string, Buffer>({
  max: 300,
  maxSize: 30 * 1024 * 1024,
  sizeCalculation: (b) => b.length,
})
const queue = new PQueue({ concurrency: 2 })
const inFlight = new Map<string, Promise<Buffer>>()

export interface FrameRequest {
  id: string
  absPath: string
  probe: ProbeResult
  /** Seconds; rounded to 0.5 s for cache hits. */
  t: number
  width: number
  /** Decode to the exact frame instead of the nearest preceding keyframe. */
  accurate: boolean
}

function coalesce(key: string, make: () => Promise<Buffer>): Promise<Buffer> {
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const running = inFlight.get(key)
  if (running) return running
  const p = queue
    .add(async () => {
      const buf = await make()
      cache.set(key, buf)
      return buf
    })
    .then((b) => b as Buffer)
    .finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

async function jpegFromArgs(args: string[], what: string): Promise<Buffer> {
  const res = await runFfmpeg(args, {
    kind: "frame",
    timeoutMs: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const buf = Buffer.from(res.stdout)
  if (res.exitCode !== 0 || buf.length === 0) {
    throw new Error(
      `Could not render ${what}: ${lastLines(res.stderr, 3) || `ffmpeg exit ${res.exitCode}`}`
    )
  }
  return buf
}

/** A small JPEG of the frame at `t` from the original file. */
export function renderFrame(req: FrameRequest): Promise<Buffer> {
  const t = Math.max(0, Math.round(req.t * 2) / 2)
  const width = Math.min(640, Math.max(64, Math.round(req.width)))
  const key = `${req.id}:${t}:${width}:${req.accurate ? 1 : 0}`
  return coalesce(key, () => {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-threads",
      "2",
      ...inputArgs(req.probe),
    ]
    if (!req.accurate) args.push("-noaccurate_seek")
    args.push(
      "-ss",
      t.toFixed(3),
      "-i",
      req.absPath,
      "-map",
      "0:V:0",
      "-frames:v",
      "1",
      "-vf",
      thumbnailFilters(req.probe, width),
      "-c:v",
      "mjpeg",
      "-q:v",
      "6",
      "-f",
      "image2pipe",
      "pipe:1"
    )
    return jpegFromArgs(args, `frame at ${t}s`)
  })
}

/** Thumbnail of a saved capture (PNG screenshot or MP4 clip). */
export async function renderCaptureThumb(
  absPath: string,
  width = 320
): Promise<Buffer> {
  const st = await fs.stat(absPath)
  const key = `capture:${absPath}:${st.mtimeMs}:${width}`
  return coalesce(key, () => {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-threads",
      "2",
      "-i",
      absPath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      `scale=w='min(${width},iw)':h=-2:flags=bilinear,format=yuvj420p`,
      "-c:v",
      "mjpeg",
      "-q:v",
      "6",
      "-f",
      "image2pipe",
      "pipe:1",
    ]
    return jpegFromArgs(args, "capture thumbnail")
  })
}

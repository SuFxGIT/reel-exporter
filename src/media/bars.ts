import { promises as fs } from "node:fs"
import { LRUCache } from "lru-cache"
import { logger } from "../logger.js"
import { runFfmpeg } from "./ffmpeg.js"
import { inputArgs, type Crop } from "./filters.js"
import type { ProbeResult } from "./probe.js"

export type { Crop } from "./filters.js"

const log = logger.child({ mod: "bars" })
// The cache cannot hold null, so "none" stands for "no bars worth trimming".
const cache = new LRUCache<string, Crop | "none">({ max: 200 })
const inFlight = new Map<string, Promise<Crop | null>>()

/** The last "crop=W:H:X:Y" ffmpeg's cropdetect printed, if any. */
export function parseCropLine(stderr: string): Crop | null {
  const re = /crop=(\d+):(\d+):(\d+):(\d+)/g
  let m: RegExpExecArray | null
  let last: Crop | null = null
  while ((m = re.exec(stderr)) !== null)
    last = {
      w: Number(m[1]),
      h: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
    }
  return last
}

/** Union of several detections: keeps every pixel any sample considered picture. */
export function mergeCrops(crops: Crop[]): Crop | null {
  if (crops.length === 0) return null
  const x = Math.min(...crops.map((c) => c.x))
  const y = Math.min(...crops.map((c) => c.y))
  const right = Math.max(...crops.map((c) => c.x + c.w))
  const bottom = Math.max(...crops.map((c) => c.y + c.h))
  return { x, y, w: right - x, h: bottom - y }
}

/**
 * Bars are worth removing when they take more than 3 % of the width or height;
 * a crop below a quarter of the frame is a dark scene, not a letterbox.
 */
export function worthTrimming(
  crop: Crop,
  width: number,
  height: number
): boolean {
  if (crop.w <= 0 || crop.h <= 0) return false
  if (crop.w * crop.h < 0.25 * width * height) return false
  return crop.w < 0.97 * width || crop.h < 0.97 * height
}

/** Up to three sample points across the range, half-second aligned. */
export function sampleTimes(start: number, end: number): number[] {
  const last = Math.max(start, end - 1.5)
  const raw = [start + 0.5, (start + end) / 2, end - 1]
  const out: number[] = []
  for (const t of raw) {
    const clamped = Math.round(Math.min(last, Math.max(start, t)) * 2) / 2
    if (!out.includes(clamped)) out.push(clamped)
  }
  return out
}

async function sample(
  absPath: string,
  probe: ProbeResult,
  t: number
): Promise<Crop | null> {
  const res = await runFfmpeg(
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "info",
      "-nostats",
      ...inputArgs(probe),
      "-ss",
      t.toFixed(3),
      "-t",
      "1.5",
      "-i",
      absPath,
      "-map",
      "0:V:0",
      "-vf",
      "cropdetect=limit=0.094:round=2:reset=0",
      "-frames:v",
      "30",
      "-f",
      "null",
      "-",
    ],
    { kind: "cropdetect", timeoutMs: 30_000, nice: 10 }
  )
  return res.exitCode === 0 ? parseCropLine(res.stderr) : null
}

/**
 * Finds black bars baked into the picture for the given range. Returns the
 * rectangle that holds the actual picture (stored pixels), or null when there
 * is nothing worth trimming. Cached per file, mtime and range.
 */
export async function detectBars(
  absPath: string,
  probe: ProbeResult,
  start: number,
  end: number
): Promise<Crop | null> {
  const v = probe.video
  if (!v || !v.width || !v.height) return null
  const st = await fs.stat(absPath).catch(() => null)
  const key = `${absPath}:${st?.mtimeMs ?? 0}:${Math.round(start * 2) / 2}:${Math.round(end * 2) / 2}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit === "none" ? null : hit
  const pending = inFlight.get(key)
  if (pending) return pending
  const run = (async () => {
    const found: Crop[] = []
    for (const t of sampleTimes(start, end)) {
      const c = await sample(absPath, probe, t)
      if (c) found.push(c)
    }
    const merged = mergeCrops(found)
    const crop =
      merged && worthTrimming(merged, v.width, v.height) ? merged : null
    log.debug(
      { file: absPath, start, end, samples: found.length, crop },
      "bars"
    )
    cache.set(key, crop ?? "none")
    return crop
  })()
  inFlight.set(key, run)
  try {
    return await run
  } finally {
    inFlight.delete(key)
  }
}

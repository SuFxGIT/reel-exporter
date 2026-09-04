import { promises as fs } from "node:fs"
import path from "node:path"
import PQueue from "p-queue"
import { config } from "../config.js"
import {
  nextCaptureNumber,
  parseCaptureNumber,
  renumberPlan,
  safeName,
} from "../library/naming.js"
import type { PlayableInfo } from "../library/store.js"
import { logger } from "../logger.js"
import { exists } from "../util/async.js"
import { toUrlPath } from "../util/paths.js"
import { lastLines, runFfmpeg, runFfprobe } from "./ffmpeg.js"
import { fullResFilters, inputArgs } from "./filters.js"
import type { ProbeResult } from "./probe.js"

const screenshotQueue = new PQueue({ concurrency: 2 })
const reserved = new Set<string>()
let allocating: Promise<unknown> = Promise.resolve()

export interface CaptureTarget {
  /** Absolute directory of the title. */
  dir: string
  /** Absolute final path. */
  absPath: string
  /** Path relative to OUTPUT_PATH, always with forward slashes. */
  relPath: string
  name: string
}

export class CaptureError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "CaptureError"
    this.status = status
    this.code = code
  }
}

/**
 * URLs for a capture. `version` identifies the file content (inode + mtime) so
 * cached thumbnails are not reused after files are renumbered.
 */
export function captureUrls(
  relPath: string,
  version?: string
): {
  url: string
  thumbUrl: string
  downloadUrl: string
} {
  const base = `/api/captures/${toUrlPath(relPath)}`
  const v = version ? `&v=${encodeURIComponent(version)}` : ""
  return {
    url: base,
    thumbUrl: `${base}?thumb=1${v}`,
    downloadUrl: `${base}?download=1`,
  }
}

export const fileVersion = (st: { ino: number; mtimeMs: number }): string =>
  `${st.ino.toString(36)}-${Math.round(st.mtimeMs).toString(36)}`

/** Reserves a unique output path: OUTPUT/<Title (Year)>/<base> - <suffix>.<ext> */
export async function allocateCapture(
  info: PlayableInfo,
  suffix: string,
  ext: string
): Promise<CaptureTarget> {
  const folder = safeName(info.folderName)
  const dir = path.join(config.outputPath, folder)
  await fs.mkdir(dir, { recursive: true })
  const stem = safeName(`${info.baseName} - ${suffix}`, 180)
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${stem}.${ext}` : `${stem} -${n}.${ext}`
    const absPath = path.join(dir, name)
    if (reserved.has(absPath) || (await exists(absPath))) continue
    reserved.add(absPath)
    return { dir, absPath, relPath: `${folder}/${name}`, name }
  }
  throw new Error("Could not find a free file name for the capture.")
}

/**
 * Folder that holds a title's screenshots: OUTPUT/<Title (Year)> for movies and
 * OUTPUT/<Show (Year)>/<S01E02> for episodes (relative to OUTPUT_PATH).
 */
export function screenshotFolder(info: PlayableInfo): string {
  const folder = safeName(info.folderName)
  return info.episodeTag ? `${folder}/${safeName(info.episodeTag)}` : folder
}

/** Reserves the next numbered screenshot name: OUTPUT/<folder>/<n>.<ext> */
export function allocateScreenshot(
  info: PlayableInfo,
  ext: string
): Promise<CaptureTarget> {
  const run = async (): Promise<CaptureTarget> => {
    const folder = screenshotFolder(info)
    const dir = path.join(config.outputPath, folder)
    await fs.mkdir(dir, { recursive: true })
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const pending = [...reserved]
      .filter((p) => path.dirname(p) === dir)
      .map((p) => path.basename(p))
    const name = `${nextCaptureNumber([...names, ...pending])}.${ext}`
    const absPath = path.join(dir, name)
    reserved.add(absPath)
    return { dir, absPath, relPath: `${folder}/${name}`, name }
  }
  // Serialised so two concurrent screenshots never pick the same number.
  const next = allocating.then(run, run)
  allocating = next.catch(() => undefined)
  return next
}

const pendingIn = (dir: string): boolean =>
  [...reserved].some((p) => path.dirname(p) === dir)

/** Applies renames in two phases so "1 -> 2" and "2 -> 1" never overwrite each other. */
async function applyRenames(
  dir: string,
  moves: Array<{ from: string; to: string }>
): Promise<void> {
  const staged = moves.map((m, i) => ({
    ...m,
    tmp: `.reorder-${process.pid}-${i}${path.extname(m.from)}`,
  }))
  for (const m of staged)
    await fs.rename(path.join(dir, m.from), path.join(dir, m.tmp))
  for (const m of staged)
    await fs.rename(path.join(dir, m.tmp), path.join(dir, m.to))
}

const numberedIn = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir).catch(() => [] as string[])).filter(
    (n) => parseCaptureNumber(n) !== null
  )

/**
 * Renumbers a title's screenshots so `names[i]` becomes `${i + 1}.<ext>`.
 * `names` must list every numbered screenshot in the folder exactly once.
 */
export function reorderScreenshots(
  info: PlayableInfo,
  names: string[]
): Promise<Array<{ from: string; to: string }>> {
  const run = async () => {
    const folder = screenshotFolder(info)
    const dir = path.join(config.outputPath, folder)
    if (pendingIn(dir))
      throw new CaptureError(
        409,
        "busy",
        "A screenshot is still being saved. Try again in a moment."
      )
    const existing = (await numberedIn(dir)).sort()
    const wanted = [...names].sort()
    if (
      wanted.length !== existing.length ||
      wanted.some((n, i) => n !== existing[i])
    )
      throw new CaptureError(
        409,
        "stale",
        "The screenshots changed since the list was loaded. Refresh and try again."
      )
    const moves = renumberPlan(names)
    if (moves.length > 0) {
      await applyRenames(dir, moves)
      logger.info({ folder, moves: moves.length }, "screenshots renumbered")
    }
    return moves
  }
  const next = allocating.then(run, run)
  allocating = next.catch(() => undefined)
  return next
}

/**
 * Closes gaps after a delete so a folder's screenshots are always 1..n in
 * their current order. Skipped while a screenshot is still being written.
 */
export function compactScreenshots(dir: string): Promise<number> {
  const run = async () => {
    if (pendingIn(dir)) return 0
    const ordered = (await numberedIn(dir)).sort(
      (a, b) => parseCaptureNumber(a)! - parseCaptureNumber(b)!
    )
    const moves = renumberPlan(ordered)
    if (moves.length > 0) {
      await applyRenames(dir, moves)
      logger.info(
        { folder: path.relative(config.outputPath, dir), moves: moves.length },
        "screenshots renumbered"
      )
    }
    return moves.length
  }
  const next = allocating.then(run, run)
  allocating = next.catch(() => undefined)
  return next
}

export function releaseCapture(target: CaptureTarget): void {
  reserved.delete(target.absPath)
}

export type ScreenshotFormat = "png" | "jpeg"

export interface ScreenshotOptions {
  format: ScreenshotFormat
  /** Downscale so the width is at most this many pixels; omit for source resolution. */
  maxWidth?: number
}

export interface ScreenshotResult {
  relPath: string
  name: string
  format: ScreenshotFormat
  width: number
  height: number
  size: number
}

async function imageDimensions(
  file: string
): Promise<{ width: number; height: number } | null> {
  const res = await runFfprobe(
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ],
    { kind: "probe", timeoutMs: 15_000 }
  )
  const m = /^(\d+),(\d+)/.exec(Buffer.from(res.stdout).toString("utf8").trim())
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

/** Writes the frame at `t` from the original file as PNG or JPEG. */
export function takeScreenshot(
  info: PlayableInfo,
  probe: ProbeResult,
  t: number,
  opts: ScreenshotOptions
): Promise<ScreenshotResult> {
  return screenshotQueue.add(async () => {
    if (!probe.hasVideo || !probe.video)
      throw new Error("This file has no video stream to capture.")
    const ext = opts.format === "jpeg" ? "jpg" : "png"
    const target = await allocateScreenshot(info, ext)
    const tmp = `${target.absPath}.tmp.${ext}`
    try {
      const encoder =
        opts.format === "jpeg"
          ? ["-c:v", "mjpeg", "-q:v", "2", "-huffman", "optimal"]
          : ["-c:v", "png", "-compression_level", "6"]
      const args = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-threads",
        "8",
        ...inputArgs(probe),
        "-ss",
        t.toFixed(3),
        "-i",
        info.absPath,
        "-map",
        "0:V:0",
        "-frames:v",
        "1",
        "-filter_threads",
        "4",
        "-vf",
        fullResFilters(
          probe,
          opts.format === "jpeg" ? "yuvj420p" : "rgb24",
          "frame",
          opts.maxWidth
        ),
        ...encoder,
        "-update",
        "1",
        "-f",
        "image2",
        tmp,
      ]
      const res = await runFfmpeg(args, {
        kind: "screenshot",
        timeoutMs: 180_000,
        nice: 10,
      })
      const st = await fs.stat(tmp).catch(() => null)
      if (res.exitCode !== 0 || !st || st.size === 0) {
        await fs.unlink(tmp).catch(() => undefined)
        throw new Error(
          `ffmpeg could not capture the frame: ${lastLines(res.stderr, 3) || `exit ${res.exitCode}`}`
        )
      }
      const dims = (await imageDimensions(tmp)) ?? {
        width: probe.video.displayWidth,
        height: probe.video.height,
      }
      await fs.rename(tmp, target.absPath)
      logger.info(
        { file: target.relPath, t, format: opts.format, ...dims },
        "screenshot saved"
      )
      return {
        relPath: target.relPath,
        name: target.name,
        format: opts.format,
        ...dims,
        size: st.size,
      }
    } finally {
      releaseCapture(target)
    }
  }) as Promise<ScreenshotResult>
}

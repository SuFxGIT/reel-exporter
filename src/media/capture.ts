import { promises as fs } from "node:fs"
import path from "node:path"
import PQueue from "p-queue"
import { config } from "../config.js"
import {
  nextCaptureNumber,
  safeName,
  safeStem,
  splitCaptureName,
} from "../library/naming.js"
import type { PlayableInfo } from "../library/store.js"
import { logger } from "../logger.js"
import { toUrlPath } from "../util/paths.js"
import { lastLines, runFfmpeg, runFfprobe } from "./ffmpeg.js"
import { screenshotEncoder, type ScreenshotFormat } from "./encoders.js"
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

/**
 * Folder that holds a title's captures: OUTPUT/<Title (Year)> for movies and
 * OUTPUT/<Show (Year)>/<S01E02> for episodes (relative to OUTPUT_PATH).
 */
export function captureFolder(info: PlayableInfo): string {
  const folder = safeName(info.folderName)
  return info.episodeTag ? `${folder}/${safeName(info.episodeTag)}` : folder
}

const pendingIn = (dir: string): string[] =>
  [...reserved]
    .filter((p) => path.dirname(p) === dir)
    .map((p) => path.basename(p))

/**
 * Reserves the next numbered name in the title's folder: OUTPUT/<folder>/<n>.<ext>.
 * One counter covers screenshots, clips, Shorts and GIFs; the number is one
 * above the highest already there, so nothing ever needs renaming.
 */
export function allocateNumbered(
  info: PlayableInfo,
  ext: string
): Promise<CaptureTarget> {
  const run = async (): Promise<CaptureTarget> => {
    const folder = captureFolder(info)
    const dir = path.join(config.outputPath, folder)
    await fs.mkdir(dir, { recursive: true })
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const name = `${nextCaptureNumber([...names, ...pendingIn(dir)])}.${ext}`
    const absPath = path.join(dir, name)
    reserved.add(absPath)
    return { dir, absPath, relPath: `${folder}/${name}`, name }
  }
  // Serialised so two concurrent captures never pick the same number.
  const next = allocating.then(run, run)
  allocating = next.catch(() => undefined)
  return next
}

/**
 * Renames a capture, keeping its extension. `targetDir` moves it at the same
 * time (older episode captures live in the show folder and are brought into
 * the episode folder when renamed). Returns the new absolute path and name.
 */
export function renameCapture(
  absPath: string,
  stem: string,
  targetDir = path.dirname(absPath)
): Promise<{ absPath: string; name: string }> {
  const run = async () => {
    const dir = targetDir
    const current = path.basename(absPath)
    const { ext } = splitCaptureName(current)
    const safe = safeStem(stem)
    if (!safe)
      throw new CaptureError(400, "bad_request", "Enter a name for the file.")
    const name = `${safe}${ext}`
    const target = path.join(dir, name)
    if (target === absPath) return { absPath, name }
    await fs.mkdir(dir, { recursive: true })
    const taken =
      reserved.has(target) ||
      (await fs.stat(target).then(
        () => true,
        () => false
      ))
    if (taken)
      throw new CaptureError(
        409,
        "exists",
        "A file with that name already exists. Choose another name."
      )
    try {
      await fs.rename(absPath, target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        throw new CaptureError(404, "not_found", "No such capture.")
      throw err
    }
    logger.info(
      { from: path.relative(config.outputPath, absPath), to: name },
      "capture renamed"
    )
    return { absPath: target, name }
  }
  const next = allocating.then(run, run)
  allocating = next.catch(() => undefined)
  return next
}

export function releaseCapture(target: CaptureTarget): void {
  reserved.delete(target.absPath)
}

export type { ScreenshotFormat } from "./encoders.js"

export interface ScreenshotOptions {
  format: ScreenshotFormat
  /** Downscale so the width is at most this many pixels; omit for source resolution. */
  maxWidth?: number
  /** 50..100 for JPEG and WebP (100 is lossless WebP); ignored for PNG. */
  quality?: number
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
    const enc = screenshotEncoder(opts.format, opts.quality)
    const ext = enc.ext
    const target = await allocateNumbered(info, ext)
    const tmp = `${target.absPath}.tmp.${ext}`
    try {
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
        fullResFilters(probe, enc.pixelFormat, "frame", opts.maxWidth),
        ...enc.args,
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
        {
          file: target.relPath,
          t,
          format: opts.format,
          quality: opts.quality,
          ...dims,
        },
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

import { promises as fs } from "node:fs"
import path from "node:path"
import PQueue from "p-queue"
import { config } from "../config.js"
import { formatTimestampForName, safeName } from "../library/naming.js"
import type { PlayableInfo } from "../library/store.js"
import { logger } from "../logger.js"
import { exists } from "../util/async.js"
import { toUrlPath } from "../util/paths.js"
import { lastLines, runFfmpeg, runFfprobe } from "./ffmpeg.js"
import { fullResFilters, inputArgs } from "./filters.js"
import type { ProbeResult } from "./probe.js"

const screenshotQueue = new PQueue({ concurrency: 2 })
const reserved = new Set<string>()

export interface CaptureTarget {
  /** Absolute directory of the title. */
  dir: string
  /** Absolute final path. */
  absPath: string
  /** Path relative to OUTPUT_PATH, always with forward slashes. */
  relPath: string
  name: string
}

export function captureUrls(relPath: string): {
  url: string
  thumbUrl: string
  downloadUrl: string
} {
  const base = `/api/captures/${toUrlPath(relPath)}`
  return {
    url: base,
    thumbUrl: `${base}?thumb=1`,
    downloadUrl: `${base}?download=1`,
  }
}

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
    const target = await allocateCapture(info, formatTimestampForName(t), ext)
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

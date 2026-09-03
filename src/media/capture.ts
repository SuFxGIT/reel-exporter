import { promises as fs } from "node:fs"
import path from "node:path"
import PQueue from "p-queue"
import { config } from "../config.js"
import { formatTimestampForName, safeName } from "../library/naming.js"
import type { PlayableInfo } from "../library/store.js"
import { logger } from "../logger.js"
import { exists } from "../util/async.js"
import { toUrlPath } from "../util/paths.js"
import { lastLines, runFfmpeg } from "./ffmpeg.js"
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

export interface ScreenshotResult {
  relPath: string
  name: string
  width: number
  height: number
  size: number
}

/** Writes a PNG of the frame at `t` from the original file, at source resolution. */
export function takeScreenshot(
  info: PlayableInfo,
  probe: ProbeResult,
  t: number
): Promise<ScreenshotResult> {
  return screenshotQueue.add(async () => {
    if (!probe.hasVideo || !probe.video)
      throw new Error("This file has no video stream to capture.")
    const target = await allocateCapture(info, formatTimestampForName(t), "png")
    const tmp = `${target.absPath}.tmp.png`
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
        fullResFilters(probe, "rgb24", "frame"),
        "-c:v",
        "png",
        "-compression_level",
        "6",
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
      await fs.rename(tmp, target.absPath)
      logger.info({ file: target.relPath, t }, "screenshot saved")
      return {
        relPath: target.relPath,
        name: target.name,
        width: probe.video.displayWidth,
        height: probe.video.height,
        size: st.size,
      }
    } finally {
      releaseCapture(target)
    }
  }) as Promise<ScreenshotResult>
}

import { promises as fs } from "node:fs"
import path from "node:path"
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express"
import { z } from "zod"
import { config } from "../config.js"
import { safeName } from "../library/naming.js"
import type { LibraryStore, PlayableInfo } from "../library/store.js"
import { logger } from "../logger.js"
import { captureUrls, takeScreenshot } from "../media/capture.js"
import type { FfmpegCapabilities } from "../media/ffmpeg.js"
import { renderCaptureThumb, renderFrame } from "../media/frames.js"
import { HlsError, hlsSessions } from "../media/hls.js"
import { jobs } from "../media/jobs.js"
import { getPeaks } from "../media/peaks.js"
import { probeFile, type ProbeResult } from "../media/probe.js"
import { isWritableDir } from "../util/async.js"
import { resolveInside } from "../util/paths.js"

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code = "error") {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface Runtime {
  mediaReadable: boolean
  configWritable: boolean
  startedAt: number
}

export interface ApiDeps {
  store: LibraryStore
  caps: FfmpegCapabilities
  runtime: Runtime
}

const CAPTURE_EXT = new Set([".png", ".jpg", ".jpeg", ".mp4"])

type Handler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown> | unknown

/** Express 5 forwards rejected promises, but wrapping keeps handlers terse. */
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body)
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ")
    throw new ApiError(400, `Invalid request: ${issues}`, "bad_request")
  }
  return r.data
}

const numberParam = (v: unknown, name: string, fallback?: number): number => {
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback
    throw new ApiError(400, `Missing query parameter "${name}".`, "bad_request")
  }
  const n = Number(v)
  if (!Number.isFinite(n))
    throw new ApiError(
      400,
      `Query parameter "${name}" must be a number.`,
      "bad_request"
    )
  return n
}

export function createApi(deps: ApiDeps): Router {
  const { store, caps, runtime } = deps
  const router = express.Router()

  async function loadPlayable(
    id: string
  ): Promise<{ info: PlayableInfo; probe: ProbeResult }> {
    const info = store.getPlayable(id)
    if (!info)
      throw new ApiError(
        404,
        "No playable item with that id. Rescan the library if the file is new.",
        "not_found"
      )
    const probe = await probeFile(id, info.absPath).catch((err) => {
      throw new ApiError(
        502,
        `Could not read the media file: ${(err as Error).message}`,
        "probe_failed"
      )
    })
    return { info, probe }
  }

  router.get(
    "/health",
    wrap(async (_req, res) => {
      const outputWritable = await isWritableDir(config.outputPath)
      const counts = store.counts()
      const body = {
        ok: runtime.mediaReadable && caps.libx264 && caps.aac,
        version: config.version,
        build: config.build,
        buildDate: config.buildDate,
        uptime: Math.round((Date.now() - runtime.startedAt) / 1000),
        ffmpeg: {
          version: caps.version,
          caps: {
            zscale: caps.zscale,
            tonemap: caps.tonemap,
            bwdif: caps.bwdif,
            libx264: caps.libx264,
            aac: caps.aac,
          },
        },
        library: {
          ...counts,
          scanning: store.scanning,
          scannedAt: store.scannedAt,
          lastError: store.lastError,
        },
        paths: {
          media: { path: config.mediaPath, readable: runtime.mediaReadable },
          output: { path: config.outputPath, writable: outputWritable },
          config: { path: config.configPath, writable: runtime.configWritable },
          transcode: config.transcodeDir,
        },
        sessions: hlsSessions.stats(),
        jobs: { active: jobs.running() },
      }
      res.status(body.ok ? 200 : 503).json(body)
    })
  )

  router.get("/library", (_req, res) => {
    res.json(store.summary())
  })

  router.post("/library/rescan", (_req, res) => {
    void store.rescan()
    res.status(202).json({ scanning: true })
  })

  router.get("/shows/:id", (req, res) => {
    const show = store.getShow(req.params.id as string)
    if (!show) throw new ApiError(404, "No show with that id.", "not_found")
    res.json(show)
  })

  router.get(
    "/items/:id",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const { info, probe } = await loadPlayable(id)
      const item = info.item
      const stat = await fs.stat(info.absPath).catch(() => null)
      res.json({
        id,
        type: item.kind,
        title: info.title,
        ...(info.year ? { year: info.year } : {}),
        ...(item.kind === "episode"
          ? {
              showId: item.showId,
              season: item.season,
              episode: item.episode,
              ...(item.episodeEnd ? { episodeEnd: item.episodeEnd } : {}),
              episodeLabel: info.episodeTag,
              ...(info.episodeTitle ? { episodeTitle: info.episodeTitle } : {}),
            }
          : {}),
        file: {
          relPath: item.relPath,
          name: path.basename(item.relPath),
          ext: item.ext,
          size: stat?.size ?? probe.sizeBytes,
        },
        duration: probe.duration,
        container: probe.container,
        hasVideo: probe.hasVideo,
        ...(probe.video ? { video: probe.video, fps: probe.video.fps } : {}),
        hdr: probe.hdr,
        audio: probe.audio,
        defaultAudio: probe.defaultAudio,
      })
    })
  )

  // ---- HLS ---------------------------------------------------------------
  router.get(
    "/items/:id/hls/:audio/:file",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const audioParam = /^a(-?\d+)$/.exec(req.params.audio as string)
      if (!audioParam)
        throw new ApiError(
          400,
          'Audio selector must look like "a0".',
          "bad_request"
        )
      const audioIdx = Number(audioParam[1])
      const file = req.params.file as string
      const { info, probe } = await loadPlayable(id)
      if (audioIdx >= probe.audio.length)
        throw new ApiError(
          400,
          "That audio track does not exist.",
          "bad_request"
        )
      const session = await hlsSessions.getOrCreate(
        id,
        audioIdx,
        info.absPath,
        probe
      )
      if (file === "index.m3u8") {
        res.type("application/vnd.apple.mpegurl")
        res.set("Cache-Control", "no-store")
        res.send(hlsSessions.playlist(session))
        return
      }
      if (file === "init.mp4") {
        const buf = await hlsSessions.getInit(session)
        res.type("video/mp4")
        res.set("Cache-Control", "private, max-age=3600")
        res.send(buf)
        return
      }
      const m = /^seg(\d{5})\.m4s$/.exec(file)
      if (!m) throw new ApiError(404, "Unknown HLS file.", "not_found")
      const segPath = await hlsSessions.getSegment(session, Number(m[1]))
      res.type("video/iso.segment")
      res.set("Cache-Control", "private, max-age=3600")
      await new Promise<void>((resolve, reject) => {
        res.sendFile(segPath, { dotfiles: "deny" }, (err) =>
          err ? reject(err) : resolve()
        )
      })
    })
  )

  router.delete(
    "/items/:id/hls/:audio",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const audioParam = /^a(-?\d+)$/.exec(req.params.audio as string)
      if (!audioParam)
        throw new ApiError(
          400,
          'Audio selector must look like "a0".',
          "bad_request"
        )
      await hlsSessions.release(id, Number(audioParam[1]))
      res.status(204).end()
    })
  )

  // ---- Frames, peaks -------------------------------------------------------
  router.get(
    "/items/:id/frame",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const { info, probe } = await loadPlayable(id)
      if (!probe.hasVideo)
        throw new ApiError(422, "This file has no video stream.", "no_video")
      const t = Math.min(
        Math.max(0, numberParam(req.query.t, "t")),
        Math.max(0, probe.duration - 0.5)
      )
      const width = numberParam(req.query.w, "w", 320)
      const accurate =
        req.query.accurate === "1" || req.query.accurate === "true"
      const buf = await renderFrame({
        id,
        absPath: info.absPath,
        probe,
        t,
        width,
        accurate,
      })
      res.type("image/jpeg")
      res.set("Cache-Control", "private, max-age=86400")
      res.send(buf)
    })
  )

  router.get(
    "/items/:id/peaks",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const { info, probe } = await loadPlayable(id)
      const audioIdx = numberParam(req.query.audio, "audio", probe.defaultAudio)
      const state = await getPeaks(id, info.absPath, probe, audioIdx)
      if (state.status === "ready") {
        res.set("Cache-Control", "private, max-age=86400")
        res.json(state.data)
      } else if (state.status === "pending") {
        res.status(202).json({ status: "pending" })
      } else {
        throw new ApiError(
          500,
          `Waveform could not be generated: ${state.error}`,
          "peaks_failed"
        )
      }
    })
  )

  // ---- Captures --------------------------------------------------------------
  const screenshotSchema = z.object({
    t: z.number().min(0),
    format: z.enum(["png", "jpeg"]).default("png"),
    maxWidth: z.number().int().min(160).max(7680).optional(),
  })
  router.post(
    "/items/:id/screenshot",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const { t, format, maxWidth } = parseBody(screenshotSchema, req.body)
      const { info, probe } = await loadPlayable(id)
      if (!probe.hasVideo)
        throw new ApiError(
          422,
          "This file has no video stream to capture.",
          "no_video"
        )
      if (t > probe.duration)
        throw new ApiError(
          400,
          "That time is past the end of the file.",
          "bad_request"
        )
      const shot = await takeScreenshot(info, probe, t, {
        format,
        ...(maxWidth ? { maxWidth } : {}),
      })
      res.status(201).json({
        file: shot.relPath,
        name: shot.name,
        format: shot.format,
        width: shot.width,
        height: shot.height,
        size: shot.size,
        t,
        ...captureUrls(shot.relPath),
      })
    })
  )

  const clipSchema = z.object({
    start: z.number().min(0),
    end: z.number().min(0),
    audio: z.number().int().min(-1).optional(),
    quality: z.enum(["high", "balanced", "small"]).default("balanced"),
    maxWidth: z.number().int().min(160).max(7680).optional(),
  })
  router.post(
    "/items/:id/clip",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const body = parseBody(clipSchema, req.body)
      const { info, probe } = await loadPlayable(id)
      const start = Math.max(0, body.start)
      const end = Math.min(body.end, probe.duration || body.end)
      if (end - start < 0.1)
        throw new ApiError(
          400,
          "Set an out point at least 0.1 seconds after the in point.",
          "bad_request"
        )
      if (end - start > config.clipMaxSeconds) {
        throw new ApiError(
          400,
          `Clips are limited to ${Math.round(config.clipMaxSeconds / 60)} minutes. Pick a shorter range.`,
          "bad_request"
        )
      }
      const audio = body.audio ?? probe.defaultAudio
      if (audio >= probe.audio.length)
        throw new ApiError(
          400,
          "That audio track does not exist.",
          "bad_request"
        )
      const job = jobs.createClip(info, probe, {
        start,
        end,
        audio,
        quality: body.quality,
        ...(body.maxWidth ? { maxWidth: body.maxWidth } : {}),
      })
      res.status(202).json({ jobId: job.id, job })
    })
  )

  router.get(
    "/items/:id/captures",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const info = store.getPlayable(id)
      if (!info)
        throw new ApiError(404, "No playable item with that id.", "not_found")
      const folder = safeName(info.folderName)
      const dir = path.join(config.outputPath, folder)
      const names = await fs.readdir(dir).catch(() => [] as string[])
      const tag = info.episodeTag ? ` - ${info.episodeTag} - ` : null
      const entries = await Promise.all(
        names
          .filter(
            (n) =>
              CAPTURE_EXT.has(path.extname(n).toLowerCase()) &&
              (!tag || n.includes(tag))
          )
          .map(async (n) => {
            const st = await fs.stat(path.join(dir, n)).catch(() => null)
            if (!st || !st.isFile()) return null
            const relPath = `${folder}/${n}`
            return {
              name: n,
              kind:
                path.extname(n).toLowerCase() === ".mp4"
                  ? ("clip" as const)
                  : ("screenshot" as const),
              size: st.size,
              mtime: st.mtime.toISOString(),
              ...captureUrls(relPath),
            }
          })
      )
      const list = entries
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
        .slice(0, 60)
      res.json({
        folder: relOrAbs(dir),
        captures: list,
        jobs: jobs
          .list(id)
          .filter((j) => j.status === "queued" || j.status === "running"),
      })
    })
  )

  const relOrAbs = (dir: string): string => dir

  const captureRoute = (req: Request): string => {
    const raw = req.params.path
    const rel = Array.isArray(raw) ? raw.join("/") : String(raw ?? "")
    const abs = resolveInside(config.outputPath, rel)
    if (!abs || !CAPTURE_EXT.has(path.extname(abs).toLowerCase()))
      throw new ApiError(404, "No such capture.", "not_found")
    return abs
  }

  router.get(
    "/captures/*path",
    wrap(async (req, res) => {
      const abs = captureRoute(req)
      const st = await fs.stat(abs).catch(() => null)
      if (!st?.isFile())
        throw new ApiError(404, "No such capture.", "not_found")
      if (req.query.thumb === "1") {
        const buf = await renderCaptureThumb(abs, 320)
        res.type("image/jpeg")
        res.set("Cache-Control", "private, max-age=3600")
        res.send(buf)
        return
      }
      if (req.query.download === "1") {
        await new Promise<void>((resolve, reject) =>
          res.download(abs, path.basename(abs), (err) =>
            err ? reject(err) : resolve()
          )
        )
        return
      }
      await new Promise<void>((resolve, reject) => {
        res.sendFile(abs, { dotfiles: "deny", acceptRanges: true }, (err) =>
          err ? reject(err) : resolve()
        )
      })
    })
  )

  router.delete(
    "/captures/*path",
    wrap(async (req, res) => {
      const abs = captureRoute(req)
      await fs.unlink(abs).catch(() => {
        throw new ApiError(404, "No such capture.", "not_found")
      })
      logger.info(
        { file: path.relative(config.outputPath, abs) },
        "capture deleted"
      )
      res.status(204).end()
    })
  )

  // ---- Jobs ------------------------------------------------------------------
  router.get("/jobs", (req, res) => {
    res.json({
      jobs: jobs.list(
        typeof req.query.item === "string" ? req.query.item : undefined
      ),
    })
  })

  router.get("/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id as string)
    if (!job)
      throw new ApiError(
        404,
        "No job with that id (finished jobs are kept for an hour).",
        "not_found"
      )
    res.json(job)
  })

  router.delete(
    "/jobs/:id",
    wrap(async (req, res) => {
      const ok = await jobs.cancel(req.params.id as string)
      if (!ok)
        throw new ApiError(404, "No cancellable job with that id.", "not_found")
      res.status(204).end()
    })
  )

  router.use((_req: Request, _res: Response, next: NextFunction) =>
    next(new ApiError(404, "Unknown API route.", "not_found"))
  )

  return router
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (res.headersSent) {
    res.end()
    return
  }
  if (err instanceof ApiError) {
    res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message } })
    return
  }
  if (err instanceof HlsError) {
    res
      .status(err.status)
      .json({ error: { code: "hls", message: err.message } })
    return
  }
  const anyErr = err as {
    status?: number
    statusCode?: number
    type?: string
    message?: string
  }
  const status = anyErr.status ?? anyErr.statusCode ?? 500
  if (status >= 500)
    logger.error({ err, url: req.originalUrl }, "request failed")
  res.status(status).json({
    error: {
      code: status >= 500 ? "internal" : "bad_request",
      message:
        status >= 500
          ? "Something went wrong on the server. Check the container logs."
          : (anyErr.message ?? "Bad request"),
    },
  })
}

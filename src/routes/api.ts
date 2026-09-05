import { promises as fs, type Dirent } from "node:fs"
import path from "node:path"
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express"
import pLimit from "p-limit"
import { z } from "zod"
import { config } from "../config.js"
import { detectMounts, isUnder, mountFor } from "../library/mounts.js"
import {
  isIgnoredEntry,
  isVideoFile,
  naturalCompare,
  parseCaptureNumber,
  safeName,
} from "../library/naming.js"
import {
  SourcesError,
  isAncestorRel,
  normalizeRelPath,
  type SourcesStore,
} from "../library/sources.js"
import type { LibraryStore, PlayableInfo } from "../library/store.js"
import { logger } from "../logger.js"
import {
  CaptureError,
  captureFolder,
  captureUrls,
  fileVersion,
  renameCapture,
  takeScreenshot,
} from "../media/capture.js"
import type { CaptureOrderStore } from "../media/capture-order.js"
import { detectBars } from "../media/bars.js"
import type { FfmpegCapabilities } from "../media/ffmpeg.js"
import { renderCaptureThumb, renderFrame } from "../media/frames.js"
import { MAX_SHORTS_ZOOM, SHORTS_ASPECTS } from "../media/filters.js"
import { HlsError, hlsSessions } from "../media/hls.js"
import {
  jobs,
  GIF_MAX_SECONDS,
  type ExportParams,
  type ShortsAspect,
} from "../media/jobs.js"
import { getPeaks } from "../media/peaks.js"
import { probeFile, type ProbeResult } from "../media/probe.js"
import { TimeoutError, isWritableDir, withTimeout } from "../util/async.js"
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
  sources: SourcesStore
  captureOrder: CaptureOrderStore
  caps: FfmpegCapabilities
  runtime: Runtime
  /** Recomputes runtime.mediaReadable after the sources changed. */
  refreshRuntime: () => Promise<void>
}

const BROWSE_MAX_FOLDERS = 2000
const BROWSE_COUNT_LIMIT = 300

const CAPTURE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".gif"])

type CaptureKind = "screenshot" | "clip" | "gif"
const captureKind = (name: string): CaptureKind => {
  const ext = path.extname(name).toLowerCase()
  return ext === ".mp4" ? "clip" : ext === ".gif" ? "gif" : "screenshot"
}

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
  const { store, sources, captureOrder, caps, runtime, refreshRuntime } = deps
  const router = express.Router()
  // Mount suggestions skip everything a source could never be, including /app.
  const mountExclude = [
    ...sources.reservedPaths,
    config.configPath,
    config.outputPath,
    config.transcodeDir,
    config.tmpRoot,
  ]

  interface SourceView {
    id: string
    path: string
    hostPath?: string
    readOnly: boolean
    exists: boolean
    readable: boolean
    libraries: Array<{
      id: string
      relPath: string
      name: string
      customName: string | null
      itemCount: number
      available: boolean
    }>
  }

  async function sourcesResponse(): Promise<{
    persistent: boolean
    scanning: boolean
    sources: SourceView[]
    candidates: Array<{ path: string; hostPath?: string; readOnly: boolean }>
  }> {
    const list = sources.list()
    const effective = sources.effective()
    const statuses = await sources.status()
    const counts = store.libraryCounts()
    const mounts = await detectMounts({ exclude: mountExclude })
    const views: SourceView[] = list.map((s) => {
      const st = statuses.find((x) => x.id === s.id)
      const eff = effective.find((x) => x.id === s.id)
      const mount = mountFor(mounts, s.path)
      return {
        id: s.id,
        path: s.path,
        ...(mount?.hostPath ? { hostPath: mount.hostPath } : {}),
        readOnly: mount?.readOnly ?? false,
        exists: st?.exists ?? false,
        readable: st?.readable ?? false,
        libraries: (eff?.libraries ?? []).map((lib, i) => {
          const c = counts.get(lib.id)
          return {
            id: lib.id,
            relPath: lib.relPath,
            name: lib.name,
            customName: s.libraries[i]?.name ?? null,
            itemCount: c?.items ?? 0,
            available: c?.available ?? true,
          }
        }),
      }
    })
    const candidates = mounts
      .filter(
        (m) =>
          !list.some((s) => isUnder(m.path, s.path) || isUnder(s.path, m.path))
      )
      .map((m) => ({
        path: m.path,
        ...(m.hostPath ? { hostPath: m.hostPath } : {}),
        readOnly: m.readOnly,
      }))
    return {
      persistent: sources.persistent,
      scanning: store.scanning,
      sources: views,
      candidates,
    }
  }

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
      const statuses = await sources.status()
      const readable = statuses.filter((s) => s.readable).length
      const body = {
        ok: caps.libx264 && caps.aac && (statuses.length === 0 || readable > 0),
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
            libwebp: caps.libwebp,
            gif: caps.gif,
            cropdetect: caps.cropdetect,
          },
        },
        library: {
          ...counts,
          scanning: store.scanning,
          scannedAt: store.scannedAt,
          lastError: store.lastError,
        },
        sources: {
          total: statuses.length,
          readable,
          libraries: sources.list().reduce((n, s) => n + s.libraries.length, 0),
          persistent: sources.persistent,
        },
        paths: {
          sources: statuses.map((s) => ({
            path: s.path,
            readable: s.readable,
          })),
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

  // ---- Sources ---------------------------------------------------------------
  const addSourceSchema = z.object({ path: z.string().trim().min(1).max(4096) })
  const librariesSchema = z.object({
    libraries: z
      .array(
        z.object({
          relPath: z.string().min(1).max(4096),
          name: z.string().trim().min(1).max(80).optional(),
        })
      )
      .max(200),
  })

  router.get(
    "/sources",
    wrap(async (_req, res) => {
      res.json(await sourcesResponse())
    })
  )

  router.post(
    "/sources",
    wrap(async (req, res) => {
      const { path: p } = parseBody(addSourceSchema, req.body)
      const created = await sources.addSource(p)
      await refreshRuntime()
      const view = (await sourcesResponse()).sources.find(
        (s) => s.id === created.id
      )
      res.status(201).json({ source: view })
    })
  )

  router.delete(
    "/sources/:id",
    wrap(async (req, res) => {
      const ok = await sources.removeSource(req.params.id as string)
      if (!ok)
        throw new ApiError(
          404,
          "No source with that id. Reload the page and try again.",
          "not_found"
        )
      await refreshRuntime()
      void store.rescan()
      res.status(204).end()
    })
  )

  router.put(
    "/sources/:id/libraries",
    wrap(async (req, res) => {
      const body = parseBody(librariesSchema, req.body)
      const updated = await sources.setLibraries(
        req.params.id as string,
        body.libraries
      )
      await refreshRuntime()
      void store.rescan()
      const view = (await sourcesResponse()).sources.find(
        (s) => s.id === updated.id
      )
      res.json({ source: view, scanning: true })
    })
  )

  router.get(
    "/sources/:id/browse",
    wrap(async (req, res) => {
      const source = sources.get(req.params.id as string)
      if (!source)
        throw new ApiError(
          404,
          "No source with that id. Reload the page and try again.",
          "not_found"
        )
      const raw = typeof req.query.path === "string" ? req.query.path : "."
      const norm = normalizeRelPath(raw)
      const abs =
        norm === null
          ? null
          : norm === "."
            ? source.path
            : resolveInside(source.path, norm)
      if (norm === null || !abs)
        throw new ApiError(
          400,
          'Path must be relative to the source and cannot contain "..".',
          "bad_request"
        )
      let entries: Dirent[]
      try {
        entries = await withTimeout(
          fs.readdir(abs, { withFileTypes: true }),
          15_000,
          `Reading ${abs}`
        )
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (err instanceof TimeoutError)
          throw new ApiError(
            504,
            `Reading ${abs} took too long. Check that the share is mounted and reachable, then try again.`,
            "timeout"
          )
        if (code === "ENOENT" || code === "ENOTDIR")
          throw new ApiError(
            404,
            `No folder "${norm}" in ${source.path}. It may have been renamed. Go up one level and try again.`,
            "not_found"
          )
        if (code === "EACCES" || code === "EPERM")
          throw new ApiError(
            403,
            `${abs} cannot be read by the app user. Fix the permissions on the host, then try again.`,
            "forbidden"
          )
        throw err
      }
      const dirs = entries
        .filter((e) => e.isDirectory() && !isIgnoredEntry(e.name))
        .sort((a, b) => naturalCompare(a.name, b.name))
      const truncated = dirs.length > BROWSE_MAX_FOLDERS
      const shown = dirs.slice(0, BROWSE_MAX_FOLDERS)
      const videoCount = entries.filter(
        (e) => e.isFile() && isVideoFile(e.name)
      ).length
      const selection = source.libraries.map((l) => l.relPath)
      const blockedFor = (rel: string): string | undefined =>
        selection.find(
          (s) => s !== rel && (isAncestorRel(s, rel) || isAncestorRel(rel, s))
        )
      const counts = new Map<string, number>()
      if (shown.length <= BROWSE_COUNT_LIMIT) {
        const limit = pLimit(8)
        await Promise.all(
          shown.map((d) =>
            limit(async () => {
              try {
                const sub = await withTimeout(
                  fs.readdir(path.join(abs, d.name), { withFileTypes: true }),
                  5000
                )
                counts.set(
                  d.name,
                  sub.filter((e) => e.isFile() && isVideoFile(e.name)).length
                )
              } catch {
                /* unreadable or slow: leave the count out */
              }
            })
          )
        )
      }
      const folders = shown.map((d) => {
        const relPath = norm === "." ? d.name : `${norm}/${d.name}`
        const c = counts.get(d.name)
        const blocked = blockedFor(relPath)
        return {
          name: d.name,
          relPath,
          ...(c !== undefined ? { videoCount: c } : {}),
          selected: selection.includes(relPath),
          ...(blocked ? { blockedBy: blocked } : {}),
        }
      })
      const blockedHere = blockedFor(norm)
      res.json({
        path: norm,
        parentPath:
          norm === "."
            ? null
            : norm.includes("/")
              ? path.posix.dirname(norm)
              : ".",
        selected: selection.includes(norm),
        ...(blockedHere ? { blockedBy: blockedHere } : {}),
        videoCount,
        truncated,
        folders,
      })
    })
  )

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
    format: z.enum(["png", "jpeg", "webp"]).default("png"),
    maxWidth: z.number().int().min(160).max(7680).optional(),
    quality: z.number().int().min(50).max(100).default(90),
  })
  router.post(
    "/items/:id/screenshot",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const { t, format, maxWidth, quality } = parseBody(
        screenshotSchema,
        req.body
      )
      if (format === "webp" && !caps.libwebp)
        throw new ApiError(
          503,
          "This ffmpeg build cannot write WebP. Choose PNG or JPEG.",
          "unsupported"
        )
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
        ...(format !== "png" ? { quality } : {}),
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

  // Black bars baked into the picture, for the Shorts crop preview.
  router.get(
    "/items/:id/bars",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const { info, probe } = await loadPlayable(id)
      if (!probe.hasVideo || !probe.video)
        throw new ApiError(422, "This file has no video stream.", "no_video")
      const duration = Math.max(0, probe.duration)
      const start = Math.min(
        Math.max(0, numberParam(req.query.start, "start", 0)),
        duration
      )
      const end = Math.min(
        Math.max(start, numberParam(req.query.end, "end", start + 5)),
        duration
      )
      const crop = caps.cropdetect
        ? await detectBars(info.absPath, probe, start, end)
        : null
      res.set("Cache-Control", "private, max-age=300")
      res.json({
        crop,
        width: probe.video.width,
        height: probe.video.height,
        sar: probe.video.sar ?? 1,
      })
    })
  )

  const clipSchema = z.object({
    start: z.number().min(0),
    end: z.number().min(0),
    audio: z.number().int().min(-1).optional(),
    quality: z.enum(["high", "balanced", "small"]).default("balanced"),
    maxWidth: z.number().int().min(160).max(7680).optional(),
    format: z.enum(["mp4", "shorts", "gif"]).default("mp4"),
    /** Shorts only: how a widescreen picture fills the 9:16 frame. */
    fit: z.enum(["blur", "crop", "bars"]).default("blur"),
    /** Shorts only: output frame. */
    aspect: z.enum(SHORTS_ASPECTS as [string, ...string[]]).default("9:16"),
    /** Shorts only: detect and drop black bars baked into the picture. */
    trimBars: z.boolean().default(true),
    /** Shorts crop only: window position, 0..1 from the left and top. */
    focus: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .optional(),
    /** Shorts crop only: how much tighter than the widest 9:16 window; 1 is the whole picture. */
    zoom: z.number().min(1).max(MAX_SHORTS_ZOOM).optional(),
    /** GIF only. */
    fps: z.number().int().min(5).max(30).default(15),
    width: z.number().int().min(160).max(1280).default(480),
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
      if (body.format === "gif" && end - start > GIF_MAX_SECONDS)
        throw new ApiError(
          400,
          `GIFs are limited to ${GIF_MAX_SECONDS} seconds. Pick a shorter range.`,
          "bad_request"
        )
      if (end - start > config.clipMaxSeconds) {
        throw new ApiError(
          400,
          `Clips are limited to ${Math.round(config.clipMaxSeconds / 60)} minutes. Pick a shorter range.`,
          "bad_request"
        )
      }
      if (body.format !== "mp4" && !probe.hasVideo)
        throw new ApiError(
          422,
          "This file has no video stream to export.",
          "no_video"
        )
      if (body.format === "gif" && !caps.gif)
        throw new ApiError(
          503,
          "This ffmpeg build cannot write GIF. Export an MP4 instead.",
          "unsupported"
        )
      const audio =
        body.format === "gif" ? -1 : (body.audio ?? probe.defaultAudio)
      if (audio >= probe.audio.length)
        throw new ApiError(
          400,
          "That audio track does not exist.",
          "bad_request"
        )
      const common = { start, end, audio, quality: body.quality }
      const params: ExportParams =
        body.format === "gif"
          ? { ...common, format: "gif", fps: body.fps, width: body.width }
          : body.format === "shorts"
            ? {
                ...common,
                format: "shorts",
                fit: body.fit,
                aspect: body.aspect as ShortsAspect,
                trimBars: body.trimBars && caps.cropdetect,
                ...(body.focus ? { focus: body.focus } : {}),
                ...(body.zoom ? { zoom: body.zoom } : {}),
              }
            : {
                ...common,
                format: "mp4",
                ...(body.maxWidth ? { maxWidth: body.maxWidth } : {}),
              }
      const job = jobs.createExport(info, probe, params)
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
      const tag = info.episodeTag ? ` - ${info.episodeTag} - ` : null
      // All captures live in the title folder (movies) or the episode
      // sub-folder; older episode captures sit in the show folder with the
      // episode tag in their name and are listed too.
      const capFolder = captureFolder(info)
      const capDir = path.join(config.outputPath, capFolder)
      const candidates: Array<{ dir: string; folder: string; name: string }> =
        []
      for (const n of await fs.readdir(capDir).catch(() => [] as string[])) {
        if (!CAPTURE_EXT.has(path.extname(n).toLowerCase())) continue
        candidates.push({ dir: capDir, folder: capFolder, name: n })
      }
      if (capDir !== dir) {
        for (const n of await fs.readdir(dir).catch(() => [] as string[])) {
          if (!CAPTURE_EXT.has(path.extname(n).toLowerCase())) continue
          if (tag && !n.includes(tag)) continue
          candidates.push({ dir, folder, name: n })
        }
      }
      const entries = await Promise.all(
        candidates.map(async (c) =>
          captureEntry(path.join(c.dir, c.name), `${c.folder}/${c.name}`)
        )
      )
      const all = entries.filter((e): e is CaptureEntry => e !== null)
      // Remembered order first, then the rest by number, then by age.
      const byRel = new Map(all.map((e) => [e.relPath, e]))
      const ordered: CaptureEntry[] = []
      for (const rel of captureOrder.get(capFolder)) {
        const e = byRel.get(rel)
        if (e) {
          ordered.push(e)
          byRel.delete(rel)
        }
      }
      const rest = [...byRel.values()].sort((a, b) => {
        const na = parseCaptureNumber(a.name)
        const nb = parseCaptureNumber(b.name)
        if (na !== null && nb !== null) return na - nb
        if (na !== null) return -1
        if (nb !== null) return 1
        return a.mtime.localeCompare(b.mtime)
      })
      const list = [...ordered, ...rest]
      res.json({
        folder: relOrAbs(capDir),
        captures: list,
        jobs: jobs
          .list(id)
          .filter((j) => j.status === "queued" || j.status === "running"),
      })
    })
  )

  const relOrAbs = (dir: string): string => dir

  interface CaptureEntry {
    name: string
    relPath: string
    kind: CaptureKind
    size: number
    mtime: string
    url: string
    thumbUrl: string
    downloadUrl: string
  }

  async function captureEntry(
    abs: string,
    relPath: string
  ): Promise<CaptureEntry | null> {
    const st = await fs.stat(abs).catch(() => null)
    if (!st || !st.isFile()) return null
    return {
      name: path.basename(abs),
      relPath,
      kind: captureKind(abs),
      size: st.size,
      mtime: st.mtime.toISOString(),
      ...captureUrls(relPath, fileVersion(st)),
    }
  }

  const orderSchema = z.object({
    relPaths: z.array(z.string().min(1).max(400)).max(2000),
  })
  router.put(
    "/items/:id/captures/order",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const info = store.getPlayable(id)
      if (!info)
        throw new ApiError(404, "No playable item with that id.", "not_found")
      const { relPaths } = parseBody(orderSchema, req.body)
      const capFolder = captureFolder(info)
      const showFolder = safeName(info.folderName)
      const inside = (rel: string) =>
        rel.startsWith(`${capFolder}/`) || rel.startsWith(`${showFolder}/`)
      if (relPaths.some((r) => !inside(r) || r.includes("/../")))
        throw new ApiError(
          400,
          "Only this title's captures can be ordered.",
          "bad_request"
        )
      if (new Set(relPaths).size !== relPaths.length)
        throw new ApiError(400, "A file is listed twice.", "bad_request")
      await captureOrder.set(capFolder, relPaths)
      res.status(204).end()
    })
  )

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
      const rel = path
        .relative(config.outputPath, abs)
        .split(path.sep)
        .join("/")
      logger.info({ file: rel }, "capture deleted")
      await captureOrder.remove(rel)
      res.status(204).end()
    })
  )

  const renameSchema = z.object({
    relPath: z.string().min(1).max(400),
    name: z.string().min(1).max(200),
  })
  router.patch(
    "/items/:id/captures/rename",
    wrap(async (req, res) => {
      const id = req.params.id as string
      const info = store.getPlayable(id)
      if (!info)
        throw new ApiError(404, "No playable item with that id.", "not_found")
      const { relPath, name } = parseBody(renameSchema, req.body)
      const abs = resolveInside(config.outputPath, relPath)
      if (!abs || !CAPTURE_EXT.has(path.extname(abs).toLowerCase()))
        throw new ApiError(404, "No such capture.", "not_found")
      const capFolder = captureFolder(info)
      const showFolder = safeName(info.folderName)
      if (
        !relPath.startsWith(`${capFolder}/`) &&
        !relPath.startsWith(`${showFolder}/`)
      )
        throw new ApiError(
          404,
          "That file does not belong to this title.",
          "not_found"
        )
      // Renamed files always end up in the title's own capture folder.
      const targetDir = path.join(config.outputPath, capFolder)
      const renamed = await renameCapture(abs, name, targetDir)
      const toRel = `${capFolder}/${renamed.name}`
      if (toRel !== relPath) await captureOrder.replace(relPath, toRel)
      const entry = await captureEntry(renamed.absPath, toRel)
      if (!entry) throw new ApiError(404, "No such capture.", "not_found")
      res.json(entry)
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
  if (err instanceof SourcesError || err instanceof CaptureError) {
    res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message } })
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

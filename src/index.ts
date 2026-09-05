import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import compression from "compression"
import express from "express"
import { pinoHttp } from "pino-http"
import { config } from "./config.js"
import { isMountPoint, readMountInfo } from "./library/mounts.js"
import { DEFAULT_RESERVED_PATHS, SourcesStore } from "./library/sources.js"
import { CaptureOrderStore } from "./media/capture-order.js"
import { LibraryStore } from "./library/store.js"
import { logger } from "./logger.js"
import { detectCapabilities, processes } from "./media/ffmpeg.js"
import { cleanTranscodeDir, hlsSessions } from "./media/hls.js"
import { jobs } from "./media/jobs.js"
import { createApi, errorHandler, type Runtime } from "./routes/api.js"
import { isWritableDir } from "./util/async.js"

const WEB_DIST = fileURLToPath(new URL("../web/dist/", import.meta.url))

/**
 * First run with no sources.json: register MEDIA_PATH as a source. False keeps the
 * sidebar empty until the user ticks folders under Sources (Plex behaviour).
 */
const SEED_ALL_LIBRARIES = false
const LEGACY_SKIP_DIRS = new Set(["books", "music", "pictures", "temp"])

async function prepareDirs(): Promise<Runtime> {
  const runtime: Runtime = {
    mediaReadable: false,
    configWritable: false,
    startedAt: Date.now(),
  }
  runtime.configWritable = await isWritableDir(config.configPath)
  if (!runtime.configWritable) {
    logger.warn(
      { path: config.configPath },
      "CONFIG_PATH is not writable; caches and transcodes fall back to a temporary directory"
    )
    config.cacheDir = path.join(config.tmpRoot, "cache")
    if (!config.transcodeDirExplicit)
      config.transcodeDir = path.join(config.tmpRoot, "transcode")
  }
  await fs.mkdir(config.cacheDir, { recursive: true })
  if (!(await isWritableDir(config.transcodeDir))) {
    logger.warn(
      { path: config.transcodeDir },
      "transcode directory is not writable; using a temporary directory"
    )
    config.transcodeDir = path.join(config.tmpRoot, "transcode")
    await fs.mkdir(config.transcodeDir, { recursive: true })
  }
  if (!(await isWritableDir(config.outputPath))) {
    logger.warn(
      { path: config.outputPath },
      "OUTPUT_PATH is not writable; screenshots and clips will fail until it is"
    )
  }
  return runtime
}

async function main(): Promise<void> {
  logger.info(
    { version: config.version, build: config.build, node: process.version },
    "Reel Vault starting"
  )
  const runtime = await prepareDirs()
  await cleanTranscodeDir()

  const caps = await detectCapabilities()
  logger.info(
    {
      ffmpeg: caps.version,
      zscale: caps.zscale,
      tonemap: caps.tonemap,
      libx264: caps.libx264,
      libwebp: caps.libwebp,
      gif: caps.gif,
    },
    "ffmpeg ready"
  )
  if (!caps.tonemap || !caps.zscale)
    logger.warn("ffmpeg lacks zscale/tonemap; HDR sources will look washed out")

  const sources = new SourcesStore({
    file: config.sourcesFile,
    writable: runtime.configWritable,
    reservedPaths: [
      ...DEFAULT_RESERVED_PATHS,
      config.configPath,
      config.outputPath,
      config.transcodeDir,
      config.tmpRoot,
    ],
    log: logger,
  })
  if ((await sources.load()) === "missing") {
    const mounts = await readMountInfo()
    if (config.legacySkipDirs)
      logger.warn(
        "SKIP_DIRS is deprecated: pick folders under Sources in the app instead"
      )
    await sources.seedFromMediaPath(config.mediaPath, {
      seedAll: SEED_ALL_LIBRARIES,
      skip: config.legacySkipDirs ?? LEGACY_SKIP_DIRS,
      mounted: isMountPoint(mounts, config.mediaPath),
    })
  }
  const refreshRuntime = async (): Promise<void> => {
    const statuses = await sources.status()
    runtime.mediaReadable = statuses.some((s) => s.readable)
  }
  await refreshRuntime()

  const store = new LibraryStore({
    sources: () => sources.effective(),
    configHash: () => sources.configHash(),
    cacheFile: path.join(config.configPath, "library.json"),
    cacheDir: () => config.cacheDir,
    log: logger,
  })
  if (runtime.configWritable) await store.loadCache()
  if (runtime.mediaReadable) void store.rescan()
  store.startInterval(config.scanIntervalMinutes)

  hlsSessions.start()
  jobs.start()

  const app = express()
  app.disable("x-powered-by")
  app.set("etag", false)
  app.use(
    pinoHttp({
      logger,
      useLevel: "debug",
      autoLogging: {
        ignore: (req) =>
          /\/hls\/|\/frame|\/captures\/|\/api\/health/.test(req.url ?? ""),
      },
    })
  )
  app.use(
    compression({
      filter: (req, res) => {
        const type = String(res.getHeader("content-type") ?? "")
        if (/^(video|image)\//.test(type)) return false
        return compression.filter(req, res)
      },
    })
  )
  app.use(express.json({ limit: "64kb" }))
  const captureOrder = new CaptureOrderStore({
    file: path.join(config.configPath, "captures.json"),
    writable: runtime.configWritable,
    log: logger,
  })
  await captureOrder.load()

  app.use(
    "/api",
    createApi({ store, sources, captureOrder, caps, runtime, refreshRuntime })
  )

  app.use(
    express.static(WEB_DIST, {
      index: false,
      maxAge: "1y",
      immutable: true,
      setHeaders: (res, file) => {
        if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache")
      },
    })
  )
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next()
    if (req.path.startsWith("/api/")) return next()
    res.sendFile(
      path.join(WEB_DIST, "index.html"),
      { headers: { "Cache-Control": "no-cache" } },
      (err) => {
        if (err) next(err)
      }
    )
  })
  app.use(errorHandler)

  const server = app.listen(config.port, "0.0.0.0", () => {
    logger.info(
      {
        port: config.port,
        sources: sources.list().map((s) => `${s.path}:${s.libraries.length}`),
        output: config.outputPath,
        config: config.configPath,
        transcode: config.transcodeDir,
      },
      "listening"
    )
  })
  server.keepAliveTimeout = 65_000

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, "shutting down")
    const forceExit = setTimeout(() => {
      logger.warn("shutdown timed out, exiting")
      processes.killAllSync()
      process.exit(1)
    }, 8000)
    forceExit.unref()
    server.close()
    store.stop()
    await Promise.allSettled([jobs.shutdown(), hlsSessions.shutdown()])
    await processes.killAll()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("exit", () => processes.killAllSync())
}

main().catch((err) => {
  logger.fatal({ err }, "startup failed")
  process.exit(1)
})

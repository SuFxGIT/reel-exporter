import os from "node:os"
import path from "node:path"
import { z } from "zod"

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(7727),
  MEDIA_PATH: z.string().default("/media"),
  OUTPUT_PATH: z.string().default("/output"),
  CONFIG_PATH: z.string().default("/config"),
  TRANSCODE_PATH: z.string().optional(),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  SCAN_INTERVAL_MINUTES: z.coerce.number().min(0).default(60),
  /** Deprecated: only consulted when the first-run seed imports every folder. */
  SKIP_DIRS: z.string().optional(),
  CLIP_MAX_SECONDS: z.coerce.number().positive().default(1800),
  TRANSCODE_MAX_MB: z.coerce.number().positive().default(4096),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  NODE_ENV: z.string().default("development"),
  REEL_VAULT_BUILD: z.string().default("dev"),
  REEL_VAULT_BUILD_DATE: z.string().default(""),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ")
  throw new Error(`Invalid environment: ${issues}`)
}
const env = parsed.data

export const config = {
  port: env.PORT,
  /** Legacy single library mount; only used to seed sources.json on first run. */
  mediaPath: path.resolve(env.MEDIA_PATH),
  outputPath: path.resolve(env.OUTPUT_PATH),
  configPath: path.resolve(env.CONFIG_PATH),
  /** Media sources and their selected library folders. */
  sourcesFile: path.join(path.resolve(env.CONFIG_PATH), "sources.json"),
  /** Probe/peaks caches. Re-pointed at tmpdir by ensureDirs() when CONFIG_PATH is not writable. */
  cacheDir: path.join(path.resolve(env.CONFIG_PATH), "cache"),
  /** HLS segments. CONFIG_PATH/transcode when writable, else tmpdir. Wiped at boot. */
  transcodeDir: env.TRANSCODE_PATH
    ? path.resolve(env.TRANSCODE_PATH)
    : path.join(path.resolve(env.CONFIG_PATH), "transcode"),
  transcodeDirExplicit: Boolean(env.TRANSCODE_PATH),
  tmpRoot: path.join(os.tmpdir(), "reel-vault"),
  logLevel: env.LOG_LEVEL,
  scanIntervalMinutes: env.SCAN_INTERVAL_MINUTES,
  legacySkipDirs: env.SKIP_DIRS
    ? new Set(
        env.SKIP_DIRS.split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      )
    : null,
  clipMaxSeconds: env.CLIP_MAX_SECONDS,
  transcodeMaxBytes: env.TRANSCODE_MAX_MB * 1024 * 1024,
  ffmpegPath: env.FFMPEG_PATH,
  ffprobePath: env.FFPROBE_PATH,
  isProduction: env.NODE_ENV === "production",
  build: env.REEL_VAULT_BUILD,
  buildDate: env.REEL_VAULT_BUILD_DATE,
  version: "0.1.0",
}

/** Tunables for the HLS transcoder and capture jobs. */
export const hls = {
  /** Segment length in seconds. Keyframes are forced at every multiple. */
  segmentSeconds: 4,
  /** Constant added to every run's timestamps so nothing is ever negative. */
  tsPad: 1.0,
  previewMaxWidth: 1920,
  /** Requests within this many segments of the running encoder wait instead of restarting it. */
  waitWindow: 6,
  /** Pause ffmpeg (SIGSTOP) when it is this many segments ahead of the player. */
  aheadPause: 10,
  /** Resume ffmpeg (SIGCONT) when it is this close to the player again. */
  aheadResume: 5,
  idleKillMs: 60_000,
  segmentWaitMs: 60_000,
  stallMs: 20_000,
  maxActiveRuns: 3,
  maxSessions: 8,
  maxSegmentsPerSession: 400,
}

export type Config = typeof config

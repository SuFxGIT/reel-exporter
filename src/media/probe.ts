import { promises as fs } from "node:fs"
import path from "node:path"
import { LRUCache } from "lru-cache"
import PQueue from "p-queue"
import { config } from "../config.js"
import { LEGACY_CONTAINERS, extOf } from "../library/naming.js"
import { logger } from "../logger.js"
import { atomicWriteJson, readJson } from "../util/async.js"
import { lastLines, runFfprobe } from "./ffmpeg.js"

export interface AudioStream {
  /** Position among audio streams; used as `-map 0:a:<index>`. */
  index: number
  streamIndex: number
  codec: string
  profile?: string
  channels: number
  channelLayout?: string
  sampleRate?: number
  language?: string
  title?: string
  default: boolean
  forced: boolean
  commentary: boolean
}

export interface VideoInfo {
  streamIndex: number
  codec: string
  profile?: string
  width: number
  height: number
  /** Sample aspect ratio (1 for square pixels). */
  sar: number
  displayWidth: number
  pixFmt?: string
  bitDepth: number
  interlaced: boolean
  fps?: number
  colorTransfer?: string
  colorPrimaries?: string
  colorSpace?: string
  colorRange?: string
}

export type HdrKind = "sdr" | "pq" | "hlg" | "dovi-p5" | "unknown-hdr"

export interface HdrInfo {
  kind: HdrKind
  /** True when the CPU tone-mapping chain applies (pq, hlg, unknown-hdr). */
  tonemap: boolean
  dovi?: { profile: number; level?: number; blCompatId?: number }
  peakNits?: number
  maxCll?: number
  maxFall?: number
}

export interface ProbeResult {
  duration: number
  container: string
  isLegacy: boolean
  hasVideo: boolean
  video?: VideoInfo
  audio: AudioStream[]
  /** Index (among audio streams) to play by default; -1 when there is no audio. */
  defaultAudio: number
  hdr: HdrInfo
  sizeBytes: number
  mtimeMs: number
  probedAt: string
}

interface CacheEntry {
  key: { size: number; mtimeMs: number }
  probe: ProbeResult
}

interface FfprobeStream {
  index: number
  codec_type?: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  sample_aspect_ratio?: string
  pix_fmt?: string
  bits_per_raw_sample?: string
  field_order?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  color_transfer?: string
  color_primaries?: string
  color_space?: string
  color_range?: string
  channels?: number
  channel_layout?: string
  sample_rate?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
  side_data_list?: Array<Record<string, unknown>>
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { format_name?: string; duration?: string; size?: string }
}

const memory = new LRUCache<string, ProbeResult>({ max: 500 })
const queue = new PQueue({ concurrency: 2 })
const inFlight = new Map<string, Promise<ProbeResult>>()

function parseRatio(s: string | undefined): number | undefined {
  if (!s) return undefined
  const [a, b] = s.split(/[/:]/).map(Number)
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b) || b === 0)
    return undefined
  return a / b
}

function parseFps(stream: FfprobeStream): number | undefined {
  for (const raw of [stream.avg_frame_rate, stream.r_frame_rate]) {
    const v = parseRatio(raw)
    if (v && v >= 5 && v <= 120) return Math.round(v * 1000) / 1000
  }
  return undefined
}

function bitDepthOf(stream: FfprobeStream): number {
  const raw = Number(stream.bits_per_raw_sample)
  if (raw > 0) return raw
  const m = /p(10|12|14|16)/.exec(stream.pix_fmt ?? "")
  return m ? Number(m[1]) : 8
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const r = parseRatio(v)
    if (r !== undefined) return r
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function classifyHdr(video: FfprobeStream | undefined): HdrInfo {
  if (!video) return { kind: "sdr", tonemap: false }
  const side = video.side_data_list ?? []
  const dovi = side.find((s) =>
    /dovi configuration/i.test(String(s.side_data_type))
  )
  const mdm = side.find((s) =>
    /mastering display/i.test(String(s.side_data_type))
  )
  const cll = side.find((s) =>
    /content light level/i.test(String(s.side_data_type))
  )
  const transfer = video.color_transfer
  const primaries = video.color_primaries
  const bitDepth = bitDepthOf(video)

  const fromTransfer = (): HdrKind => {
    if (transfer === "smpte2084") return "pq"
    if (transfer === "arib-std-b67") return "hlg"
    if (
      primaries === "bt2020" &&
      bitDepth >= 10 &&
      (!transfer || transfer === "unknown" || transfer === "bt2020-10")
    ) {
      return "unknown-hdr"
    }
    return "sdr"
  }

  let kind: HdrKind
  let doviInfo: HdrInfo["dovi"]
  if (dovi) {
    const profile = num(dovi.dv_profile) ?? 0
    const level = num(dovi.dv_level)
    const blCompatId = num(dovi.dv_bl_signal_compatibility_id)
    doviInfo = {
      profile,
      ...(level !== undefined ? { level } : {}),
      ...(blCompatId !== undefined ? { blCompatId } : {}),
    }
    if (profile === 5) kind = "dovi-p5"
    else if (blCompatId === 1 || blCompatId === 6) kind = "pq"
    else if (blCompatId === 4) kind = "hlg"
    else if (blCompatId === 2) kind = "sdr"
    else kind = fromTransfer()
  } else {
    kind = fromTransfer()
  }

  const info: HdrInfo = {
    kind,
    tonemap: kind === "pq" || kind === "hlg" || kind === "unknown-hdr",
  }
  if (doviInfo) info.dovi = doviInfo
  const maxLum = mdm ? num(mdm.max_luminance) : undefined
  if (maxLum && maxLum > 0) info.peakNits = Math.round(maxLum)
  const maxCll = cll ? num(cll.max_content) : undefined
  const maxFall = cll ? num(cll.max_average) : undefined
  if (maxCll && maxCll > 0) info.maxCll = maxCll
  if (maxFall && maxFall > 0) info.maxFall = maxFall
  return info
}

export function interpretProbe(
  json: FfprobeOutput,
  absPath: string,
  stat: { size: number; mtimeMs: number }
): ProbeResult {
  const streams = json.streams ?? []
  const video = streams.find(
    (s) => s.codec_type === "video" && !(s.disposition?.attached_pic === 1)
  )
  const audioStreams = streams.filter((s) => s.codec_type === "audio")
  const ext = extOf(absPath)
  const container = (json.format?.format_name ?? ext).split(",")[0] ?? ext

  let duration = Number(json.format?.duration) || 0
  const videoDuration = Number(video?.duration) || 0
  if (
    videoDuration > 0 &&
    (duration <= 0 || Math.abs(duration - videoDuration) > 2)
  ) {
    duration = duration > 0 ? Math.min(duration, videoDuration) : videoDuration
  }

  let videoInfo: VideoInfo | undefined
  if (video && video.width && video.height) {
    const sar = parseRatio(video.sample_aspect_ratio) || 1
    const fps = parseFps(video)
    const fieldOrder = video.field_order
    videoInfo = {
      streamIndex: video.index,
      codec: video.codec_name ?? "unknown",
      ...(video.profile ? { profile: video.profile } : {}),
      width: video.width,
      height: video.height,
      sar,
      displayWidth: Math.round(video.width * sar),
      ...(video.pix_fmt ? { pixFmt: video.pix_fmt } : {}),
      bitDepth: bitDepthOf(video),
      interlaced: Boolean(
        fieldOrder && fieldOrder !== "progressive" && fieldOrder !== "unknown"
      ),
      ...(fps ? { fps } : {}),
      ...(video.color_transfer ? { colorTransfer: video.color_transfer } : {}),
      ...(video.color_primaries
        ? { colorPrimaries: video.color_primaries }
        : {}),
      ...(video.color_space ? { colorSpace: video.color_space } : {}),
      ...(video.color_range ? { colorRange: video.color_range } : {}),
    }
  }

  const audio: AudioStream[] = audioStreams.map((s, i) => {
    const title = s.tags?.title ?? s.tags?.TITLE
    const language = s.tags?.language ?? s.tags?.LANGUAGE
    return {
      index: i,
      streamIndex: s.index,
      codec: s.codec_name ?? "unknown",
      ...(s.profile ? { profile: s.profile } : {}),
      channels: s.channels ?? 2,
      ...(s.channel_layout ? { channelLayout: s.channel_layout } : {}),
      ...(s.sample_rate ? { sampleRate: Number(s.sample_rate) } : {}),
      ...(language && language !== "und" ? { language } : {}),
      ...(title ? { title } : {}),
      default: s.disposition?.default === 1,
      forced: s.disposition?.forced === 1,
      commentary: s.disposition?.comment === 1 || /comment/i.test(title ?? ""),
    }
  })
  const preferred =
    audio.find((a) => a.default && !a.commentary) ??
    audio.find((a) => !a.commentary) ??
    audio[0]

  return {
    duration,
    container,
    isLegacy:
      LEGACY_CONTAINERS.has(ext) || /avi|mpeg|mpegts|asf|ogg/.test(container),
    hasVideo: videoInfo !== undefined,
    ...(videoInfo ? { video: videoInfo } : {}),
    audio,
    defaultAudio: preferred ? preferred.index : -1,
    hdr: classifyHdr(video),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    probedAt: new Date().toISOString(),
  }
}

function cacheFile(id: string): string {
  return path.join(config.cacheDir, "probe", `${id}.json`)
}

async function runProbe(
  absPath: string,
  isLegacy: boolean
): Promise<FfprobeOutput> {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
  ]
  if (isLegacy) args.push("-analyzeduration", "20M", "-probesize", "50M")
  args.push("-i", absPath)
  const res = await runFfprobe(args, { kind: "probe", timeoutMs: 60_000 })
  if (res.exitCode !== 0) {
    throw new Error(
      `ffprobe failed for ${path.basename(absPath)}: ${lastLines(res.stderr, 3) || `exit ${res.exitCode}`}`
    )
  }
  return JSON.parse(Buffer.from(res.stdout).toString("utf8")) as FfprobeOutput
}

/** Probes a file, using the on-disk cache keyed by size+mtime and an in-memory LRU. */
export async function probeFile(
  id: string,
  absPath: string
): Promise<ProbeResult> {
  const stat = await fs.stat(absPath)
  const key = { size: stat.size, mtimeMs: stat.mtimeMs }
  const cached = memory.get(id)
  if (cached && cached.sizeBytes === key.size && cached.mtimeMs === key.mtimeMs)
    return cached

  const running = inFlight.get(id)
  if (running) return running

  const p = queue
    .add(async (): Promise<ProbeResult> => {
      const file = cacheFile(id)
      const disk = await readJson<CacheEntry>(file)
      if (
        disk &&
        disk.key.size === key.size &&
        disk.key.mtimeMs === key.mtimeMs &&
        disk.probe
      ) {
        memory.set(id, disk.probe)
        return disk.probe
      }
      const started = Date.now()
      const json = await runProbe(
        absPath,
        LEGACY_CONTAINERS.has(extOf(absPath))
      )
      const probe = interpretProbe(json, absPath, key)
      memory.set(id, probe)
      logger.debug(
        {
          id,
          ms: Date.now() - started,
          duration: probe.duration,
          hdr: probe.hdr.kind,
        },
        "probe"
      )
      atomicWriteJson(file, { key, probe } satisfies CacheEntry).catch((err) =>
        logger.warn(
          { err: (err as Error).message },
          "probe: cache write failed"
        )
      )
      return probe
    })
    .then((r) => r as ProbeResult)
    .finally(() => inFlight.delete(id))
  inFlight.set(id, p)
  return p
}

export function forgetProbe(id: string): void {
  memory.delete(id)
}

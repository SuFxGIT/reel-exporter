import { useCallback, useState } from "react"

export type ScreenshotFormat = "png" | "jpeg" | "webp"
export type SizePreset = "source" | "1080" | "720" | "custom"
export type ClipQuality = "high" | "balanced" | "small"
export type ExportFormat = "mp4" | "gif"
/** What fills the frame where the picture does not cover it. */
export type FrameBackground = "black" | "blur"
export type FrameAspect = "9:16" | "4:5" | "1:1" | "4:3" | "16:9"
/** The source picture's own aspect, or a fixed frame. */
export type ExportAspect = "source" | FrameAspect

export const FRAME_RATIOS: Record<FrameAspect, number> = {
  "9:16": 9 / 16,
  "4:5": 4 / 5,
  "1:1": 1,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
}
/** The UI caps zoom at 2.5 although the server accepts up to 4. */
export const CROP_ZOOM_RANGE = { min: 0.25, max: 2.5 }
export const CROP_WIDTH_RANGE = { min: 0.5, max: 1.5 }
export type GifWidth = 320 | 480 | 640
export type GifFps = 10 | 15 | 20

/** GIFs grow fast; the server refuses longer ranges. */
export const GIF_MAX_SECONDS = 30

export interface ScreenshotOptions {
  format: ScreenshotFormat
  size: SizePreset
  /** Used when size is "custom". */
  customWidth: number
  /** 50..100 for JPEG and WebP; 100 makes WebP lossless. Ignored for PNG. */
  quality: number
}

export interface ClipOptions {
  format: ExportFormat
  size: Exclude<SizePreset, "custom">
  quality: ClipQuality
  /** Include the selected audio track. */
  audio: boolean
  /** Video: the source picture's aspect, or a fixed frame. */
  aspect: ExportAspect
  /** Fixed aspects: where the window sits, 0..1 from the left and top. */
  cropFocus: { x: number; y: number }
  /** Fixed aspects: 1 covers the frame; above crops tighter, below shows the background. */
  cropZoom: number
  /** Fixed aspects: horizontal squeeze or stretch; 1 is the real width. */
  cropWidth: number
  /** Fixed aspects: what fills the frame around the picture. */
  background: FrameBackground
  gifWidth: GifWidth
  gifFps: GifFps
}

export const defaultScreenshotOptions: ScreenshotOptions = {
  format: "png",
  size: "source",
  customWidth: 1280,
  quality: 90,
}
export const defaultClipOptions: ClipOptions = {
  format: "mp4",
  size: "source",
  quality: "balanced",
  audio: true,
  aspect: "source",
  cropFocus: { x: 0.5, y: 0.5 },
  cropZoom: 1,
  cropWidth: 1,
  background: "blur",
  gifWidth: 480,
  gifFps: 15,
}

const SCREENSHOT_KEY = "reel-exporter:screenshot-options"
const CLIP_KEY = "reel-exporter:clip-options-v3"
/** Before the Blur, Crop and Bars fits became one placement with a background. */
const V2_CLIP_KEY = "reel-exporter:clip-options-v2"
/** Before the Shorts format was folded into Video. */
const V1_CLIP_KEY = "reel-exporter:clip-options"

/** Width limit sent to the server for a size preset; undefined means source resolution. */
export function maxWidthFor(
  size: SizePreset,
  customWidth?: number
): number | undefined {
  switch (size) {
    case "1080":
      return 1920
    case "720":
      return 1280
    case "custom":
      return customWidth && customWidth >= 160
        ? Math.min(7680, Math.round(customWidth))
        : undefined
    default:
      return undefined
  }
}

/** Short side sent to the server for a fixed-aspect export; undefined means native resolution. */
export function shortSideFor(size: SizePreset): number | undefined {
  return size === "1080" ? 1080 : size === "720" ? 720 : undefined
}

export function sizeLabel(size: SizePreset, customWidth?: number): string {
  switch (size) {
    case "1080":
      return "1080p"
    case "720":
      return "720p"
    case "custom":
      return `${customWidth ?? ""} px wide`
    default:
      return "Source"
  }
}

function load<T extends object>(key: string, fallback: T): T {
  try {
    // Settings saved under the old product name are picked up once.
    const raw =
      localStorage.getItem(key) ??
      localStorage.getItem(key.replace("reel-exporter:", "reel-vault:"))
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<T>
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

function readRaw(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Clip options, migrating settings saved by earlier versions of the popover. */
function loadClip(): ClipOptions {
  const current = readRaw(CLIP_KEY)
  if (current)
    return { ...defaultClipOptions, ...(current as Partial<ClipOptions>) }
  const v2 = readRaw(V2_CLIP_KEY)
  const v1 = v2 ? null : readRaw(V1_CLIP_KEY)
  if (!v2 && !v1) return defaultClipOptions
  const old = (v2 ?? v1) as Omit<Partial<ClipOptions>, "format" | "aspect"> & {
    format?: string
    aspect?: string
    fit?: string
  }
  const { format, aspect, fit, ...rest } = old
  const frame = (Object.keys(FRAME_RATIOS) as FrameAspect[]).find(
    (a) => a === aspect
  )
  const next: ClipOptions = {
    ...defaultClipOptions,
    ...rest,
    format: format === "gif" ? "gif" : "mp4",
    // v1 only used the aspect for the Shorts format; MP4 users kept the source picture.
    aspect: v1
      ? format === "shorts" && frame
        ? frame
        : "source"
      : (frame ?? "source"),
    // The Bars fit was black behind the picture; Blur and Crop looked like blur.
    background: fit === "bars" ? "black" : "blur",
  }
  save(CLIP_KEY, next)
  return next
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

/** Export choices remembered per browser; the S and E shortcuts reuse them. */
export function useExportOptions() {
  const [screenshot, setScreenshotState] = useState<ScreenshotOptions>(() =>
    load(SCREENSHOT_KEY, defaultScreenshotOptions)
  )
  const [clip, setClipState] = useState<ClipOptions>(loadClip)
  const setScreenshot = useCallback((patch: Partial<ScreenshotOptions>) => {
    setScreenshotState((cur) => {
      const next = { ...cur, ...patch }
      save(SCREENSHOT_KEY, next)
      return next
    })
  }, [])
  const setClip = useCallback((patch: Partial<ClipOptions>) => {
    setClipState((cur) => {
      const next = { ...cur, ...patch }
      save(CLIP_KEY, next)
      return next
    })
  }, [])
  return { screenshot, setScreenshot, clip, setClip }
}

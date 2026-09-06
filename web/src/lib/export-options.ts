import { useCallback, useState } from "react"

export type ScreenshotFormat = "png" | "jpeg" | "webp"
export type SizePreset = "source" | "1080" | "720" | "custom"
export type ClipQuality = "high" | "balanced" | "small"
export type ExportFormat = "mp4" | "gif"
export type FrameFit = "blur" | "crop" | "bars"
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
  /** Video, fixed aspects: how the picture fills the frame. */
  fit: FrameFit
  /** Crop fit: where the window sits, 0..1 from the left and top. */
  cropFocus: { x: number; y: number }
  /** Crop fit: how much tighter than the widest window; 1 is the whole picture. */
  cropZoom: number
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
  fit: "blur",
  cropFocus: { x: 0.5, y: 0.5 },
  cropZoom: 1,
  gifWidth: 480,
  gifFps: 15,
}

const SCREENSHOT_KEY = "reel-exporter:screenshot-options"
const CLIP_KEY = "reel-exporter:clip-options-v2"
/** Before the Shorts format was folded into Video. */
const LEGACY_CLIP_KEY = "reel-exporter:clip-options"

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

/** Clip options, migrating settings saved when Shorts was its own format. */
function loadClip(): ClipOptions {
  try {
    if (localStorage.getItem(CLIP_KEY))
      return load(CLIP_KEY, defaultClipOptions)
  } catch {
    return defaultClipOptions
  }
  type Legacy = Omit<Partial<ClipOptions>, "format" | "aspect"> & {
    format?: string
    aspect?: string
  }
  const { format, aspect, ...rest } = load<Legacy>(LEGACY_CLIP_KEY, {})
  const frame = (Object.keys(FRAME_RATIOS) as FrameAspect[]).find(
    (a) => a === aspect
  )
  const next: ClipOptions = {
    ...defaultClipOptions,
    ...rest,
    format: format === "gif" ? "gif" : "mp4",
    // Only the Shorts format used the aspect; MP4 users kept the source picture.
    aspect: format === "shorts" && frame ? frame : "source",
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

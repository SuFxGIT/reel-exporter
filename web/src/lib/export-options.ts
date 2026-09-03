import { useCallback, useState } from "react"

export type ScreenshotFormat = "png" | "jpeg"
export type SizePreset = "source" | "1080" | "720" | "custom"
export type ClipQuality = "high" | "balanced" | "small"

export interface ScreenshotOptions {
  format: ScreenshotFormat
  size: SizePreset
  /** Used when size is "custom". */
  customWidth: number
}

export interface ClipOptions {
  size: Exclude<SizePreset, "custom">
  quality: ClipQuality
  /** Include the selected audio track. */
  audio: boolean
}

export const defaultScreenshotOptions: ScreenshotOptions = {
  format: "png",
  size: "source",
  customWidth: 1280,
}
export const defaultClipOptions: ClipOptions = {
  size: "source",
  quality: "balanced",
  audio: true,
}

const SCREENSHOT_KEY = "reel-vault:screenshot-options"
const CLIP_KEY = "reel-vault:clip-options"

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
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<T>
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
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
  const [clip, setClipState] = useState<ClipOptions>(() =>
    load(CLIP_KEY, defaultClipOptions)
  )
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

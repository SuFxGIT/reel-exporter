import { hls } from "../config.js"
import type { ProbeResult } from "./probe.js"

/**
 * CPU tone-mapping for PQ/HLG sources (zscale + tonemap). Returns null when the
 * source is SDR or Dolby Vision profile 5 (which has no tonemappable base layer).
 */
export function tonemapChain(probe: ProbeResult): string | null {
  const { hdr } = probe
  if (!hdr.tonemap) return null
  // Without mastering-display or CLL metadata the tonemap filter assumes a 10000 nit
  // peak for PQ and the picture goes very dark; 1000 nits is the common mastering peak.
  const peak =
    hdr.kind !== "hlg" && !hdr.peakNits && !hdr.maxCll ? ":peak=10" : ""
  return [
    "zscale=t=linear:npl=100",
    "format=gbrpf32le",
    "zscale=p=bt709",
    `tonemap=tonemap=hable:desat=0${peak}`,
    "zscale=t=bt709:m=bt709:r=tv",
  ].join(",")
}

export function deinterlaceFilter(
  probe: ProbeResult,
  mode: "frame" | "field" = "frame"
): string | null {
  return probe.video?.interlaced
    ? `bwdif=mode=send_${mode}:parity=auto:deint=all`
    : null
}

/**
 * Some SDR sources (ProRes .mov exports in particular) carry a reserved or missing
 * transfer characteristic. ffmpeg 8's swscale refuses every conversion from such
 * frames ("Unsupported input"), so tag them as BT.709 before anything else runs.
 * HDR sources always have a known transfer and are left alone.
 */
export function colorFixup(probe: ProbeResult): string | null {
  if (probe.hdr.tonemap) return null
  const t = probe.video?.colorTransfer
  return !t || t === "unknown" || t === "reserved"
    ? "setparams=color_trc=bt709"
    : null
}

function squarePixels(probe: ProbeResult): string | null {
  const sar = probe.video?.sar ?? 1
  return Math.abs(sar - 1) > 0.01
    ? "scale=w=iw*sar:h=ih:flags=bicubic,setsar=1"
    : null
}

/** Preview stream: deinterlace, downscale to the preview width, tone-map, 8-bit 4:2:0. */
export function previewFilters(probe: ProbeResult): string {
  const parts: string[] = []
  const fix = colorFixup(probe)
  if (fix) parts.push(fix)
  const de = deinterlaceFilter(probe)
  if (de) parts.push(de)
  parts.push(
    `scale=w='min(${hls.previewMaxWidth},iw*sar)':h=-2:flags=bicubic`,
    "setsar=1"
  )
  const tm = tonemapChain(probe)
  if (tm) parts.push(tm)
  parts.push("format=yuv420p")
  return parts.join(",")
}

/** A rectangle in stored source pixels. */
export interface Crop {
  w: number
  h: number
  x: number
  y: number
}

const cropFilter = (c: Crop): string =>
  `crop=w=${c.w}:h=${c.h}:x=${c.x}:y=${c.y}`

/** Everything before the final pixel-format step: fixup, deinterlace, crop, downscale, tone-map. */
function prepFilters(
  probe: ProbeResult,
  deinterlaceMode: "frame" | "field",
  maxWidth?: number,
  preCrop?: Crop
): string[] {
  const parts: string[] = []
  const fix = colorFixup(probe)
  if (fix) parts.push(fix)
  const de = deinterlaceFilter(probe, deinterlaceMode)
  if (de) parts.push(de)
  if (preCrop) parts.push(cropFilter(preCrop))
  const sourceWidth = probe.video
    ? preCrop
      ? preCrop.w * (probe.video.sar ?? 1)
      : probe.video.displayWidth
    : 0
  if (maxWidth && probe.video && maxWidth < sourceWidth) {
    // Downscale before tone-mapping: that is where the cost is.
    parts.push(
      `scale=w='min(${maxWidth},iw*sar)':h=-2:flags=lanczos`,
      "setsar=1"
    )
  } else {
    const sq = squarePixels(probe)
    if (sq) parts.push(sq)
    // Without a scale filter ffmpeg converts at the graph input, before setparams
    // has run, and the fixup is lost. Make the conversion an explicit step.
    else if (fix) parts.push("scale=w=iw:h=ih")
  }
  const tm = tonemapChain(probe)
  if (tm) parts.push(tm)
  return parts
}

/** Full-resolution output (screenshots, clips). */
export function fullResFilters(
  probe: ProbeResult,
  pixelFormat: "yuv420p" | "rgb24" | "yuvj420p" | "bgra",
  deinterlaceMode: "frame" | "field",
  maxWidth?: number
): string {
  return [
    ...prepFilters(probe, deinterlaceMode, maxWidth),
    `format=${pixelFormat}`,
  ].join(",")
}

// ---------------------------------------------------------------------------
// Shorts output: a fixed frame (9:16 by default) the picture is fitted into
// ---------------------------------------------------------------------------

export type ShortsFit = "blur" | "crop" | "bars"
export type ShortsAspect = "9:16" | "4:5" | "1:1" | "4:3" | "16:9"
export const SHORTS_ASPECTS: ShortsAspect[] = [
  "9:16",
  "4:5",
  "1:1",
  "4:3",
  "16:9",
]
export const DEFAULT_SHORTS_ASPECT: ShortsAspect = "9:16"

export interface ShortsFrame {
  width: number
  height: number
}

/** Output sizes: 1080 on the short side, the popular vertical, square and landscape frames. */
const SHORTS_FRAMES: Record<ShortsAspect, ShortsFrame> = {
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
}

export const shortsFrame = (aspect?: ShortsAspect): ShortsFrame =>
  SHORTS_FRAMES[aspect ?? DEFAULT_SHORTS_ASPECT] ?? SHORTS_FRAMES["9:16"]

export const SHORTS_WIDTH = SHORTS_FRAMES["9:16"].width
export const SHORTS_HEIGHT = SHORTS_FRAMES["9:16"].height

/**
 * Width to downscale to before tone-mapping so the expensive filters run at
 * the size the frame needs rather than at source size.
 */
export function shortsPrescaleWidth(
  probe: ProbeResult,
  fit: ShortsFit,
  picture?: { width: number; height: number },
  zoom = 1,
  frame: ShortsFrame = shortsFrame()
): number | undefined {
  const v = probe.video
  if (!v || !v.height) return undefined
  const width = picture?.width ?? v.displayWidth
  const height = picture?.height ?? v.height
  if (!height) return undefined
  const atHeight = Math.round((frame.height * width) / height)
  const wanted =
    fit === "bars"
      ? Math.min(frame.width, atHeight)
      : fit === "crop"
        ? Math.round(Math.max(frame.width, atHeight) * clampZoom(zoom))
        : Math.max(frame.width, atHeight)
  // 4:2:0 output needs even dimensions; round up so nothing is lost.
  const box = wanted + (wanted % 2)
  return box < width ? box : undefined
}

export interface ShortsOptions {
  /** Output frame; 9:16 when omitted. */
  aspect?: ShortsAspect
  /** Picture rectangle without the black bars; applied before scaling. */
  bars?: Crop
  /** Where the crop window sits, 0..1 from the left/top; 0.5 is centred. */
  focus?: { x: number; y: number }
  /** Crop fit only: how much tighter than the widest window; 1 is the whole picture. */
  zoom?: number
}

export const MAX_SHORTS_ZOOM = 4
const clampZoom = (z: number | undefined): number =>
  Number.isFinite(z) ? Math.min(MAX_SHORTS_ZOOM, Math.max(1, z as number)) : 1

const fraction = (n: number): string => Math.min(1, Math.max(0, n)).toFixed(3)
const even = (n: number): number => Math.round(n / 2) * 2

/** Picture centred over a blurred copy. Blur a small copy and scale it back up: same look, a fraction of the cost. */
const blurFit = ({ width: W, height: H }: ShortsFrame): string => {
  const w = even(W / 4)
  const h = even(H / 4)
  return [
    "split[bg][fg]",
    `[bg]scale=w=${w}:h=${h}:force_original_aspect_ratio=increase:flags=bicubic,crop=w=${w}:h=${h},gblur=sigma=8,scale=w=${W}:h=${H}:flags=bicubic[bgb]`,
    `[fg]scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fgs]`,
    "[bgb][fgs]overlay=x=(W-w)/2:y=(H-h)/2:format=yuv420,format=yuv420p",
  ].join(";")
}

/** Picture centred on black. */
const barsFit = ({ width: W, height: H }: ShortsFrame): string =>
  `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=w=${W}:h=${H}:x=(ow-iw)/2:y=(oh-ih)/2:color=black`

/**
 * Fill the frame, then cut the window at the chosen position. Zoom scales the
 * picture past the frame so the window covers 1/zoom of it; the crop stays the
 * frame size, so the aspect ratio never changes.
 */
const cropFit = (
  { width: W, height: H }: ShortsFrame,
  focus: { x: number; y: number } = { x: 0.5, y: 0.5 },
  zoom = 1
): string => {
  const z = clampZoom(zoom)
  return `scale=w=${even(W * z)}:h=${even(H * z)}:force_original_aspect_ratio=increase:flags=lanczos,crop=w=${W}:h=${H}:x=(iw-${W})*${fraction(focus.x)}:y=(ih-${H})*${fraction(focus.y)}`
}

/** Shorts and Reels output: drop the bars, fit the picture, fill the frame. */
export function shortsFilters(
  probe: ProbeResult,
  fit: ShortsFit,
  opts: ShortsOptions = {}
): string {
  const frame = shortsFrame(opts.aspect)
  const sar = probe.video?.sar ?? 1
  const picture = opts.bars
    ? { width: opts.bars.w * sar, height: opts.bars.h }
    : undefined
  return [
    ...prepFilters(
      probe,
      "field",
      shortsPrescaleWidth(probe, fit, picture, opts.zoom, frame),
      opts.bars
    ),
    "format=yuv420p",
    fit === "crop"
      ? cropFit(frame, opts.focus, opts.zoom)
      : fit === "blur"
        ? blurFit(frame)
        : barsFit(frame),
  ].join(",")
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

/**
 * Frame-rate reduction and downscale for a GIF; shared by the palette pass and
 * the encode pass. The scale is always present so the colour fixup applies.
 */
export function gifFilters(
  probe: ProbeResult,
  opts: { fps: number; width: number }
): string {
  const parts: string[] = []
  const fix = colorFixup(probe)
  if (fix) parts.push(fix)
  const de = deinterlaceFilter(probe)
  if (de) parts.push(de)
  parts.push(
    `fps=${opts.fps}`,
    `scale=w='min(${opts.width},iw*sar)':h=-2:flags=lanczos`,
    "setsar=1"
  )
  const tm = tonemapChain(probe)
  if (tm) parts.push(tm)
  return parts.join(",")
}

export const GIF_PALETTE = "palettegen=stats_mode=full"
export const GIF_PALETTEUSE =
  "paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"

/** Small preview frame (hover thumbnails, capture thumbnails). */
export function thumbnailFilters(probe: ProbeResult, width: number): string {
  const parts: string[] = []
  const fix = colorFixup(probe)
  if (fix) parts.push(fix)
  const de = deinterlaceFilter(probe)
  if (de) parts.push(de)
  parts.push(`scale=w='min(${width},iw*sar)':h=-2:flags=bilinear`, "setsar=1")
  const tm = tonemapChain(probe)
  if (tm) parts.push(tm)
  parts.push("format=yuvj420p")
  return parts.join(",")
}

/** Input-side options for containers with unreliable timestamps or indexes. */
export function inputArgs(probe: ProbeResult): string[] {
  return probe.isLegacy
    ? ["-fflags", "+genpts", "-analyzeduration", "20M", "-probesize", "50M"]
    : []
}

/** Output colour tags after tone-mapping so players do not misinterpret the stream. */
export function colorTagArgs(probe: ProbeResult): string[] {
  return probe.hdr.tonemap
    ? [
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
      ]
    : []
}

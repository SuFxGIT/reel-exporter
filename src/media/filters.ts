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

/** Full-resolution output (screenshots, clips). `preCrop` drops detected black bars first. */
export function fullResFilters(
  probe: ProbeResult,
  pixelFormat: "yuv420p" | "rgb24" | "yuvj420p" | "bgra",
  deinterlaceMode: "frame" | "field",
  maxWidth?: number,
  preCrop?: Crop
): string {
  return [
    ...prepFilters(probe, deinterlaceMode, maxWidth, preCrop),
    `format=${pixelFormat}`,
  ].join(",")
}

// ---------------------------------------------------------------------------
// Framed output: the picture placed in a fixed aspect (9:16, 1:1, 16:9, ...)
// ---------------------------------------------------------------------------

export type FrameAspect = "9:16" | "4:5" | "1:1" | "4:3" | "16:9"
export const FRAME_ASPECTS: FrameAspect[] = [
  "9:16",
  "4:5",
  "1:1",
  "4:3",
  "16:9",
]
export const DEFAULT_FRAME_ASPECT: FrameAspect = "9:16"
/** What shows where the picture does not cover the frame. */
export type FrameBackground = "black" | "blur"

const FRAME_RATIOS: Record<FrameAspect, number> = {
  "9:16": 9 / 16,
  "4:5": 4 / 5,
  "1:1": 1,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
}

export const MIN_CROP_ZOOM = 0.25
export const MAX_CROP_ZOOM = 4
export const MIN_WIDTH_SCALE = 0.5
export const MAX_WIDTH_SCALE = 1.5
const clampZoom = (z: number | undefined): number =>
  Number.isFinite(z)
    ? Math.min(MAX_CROP_ZOOM, Math.max(MIN_CROP_ZOOM, z as number))
    : 1
const clampWidth = (k: number | undefined): number =>
  Number.isFinite(k)
    ? Math.min(MAX_WIDTH_SCALE, Math.max(MIN_WIDTH_SCALE, k as number))
    : 1
const clamp01 = (n: number | undefined): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n as number)) : 0.5

const even = (n: number): number => Math.round(n / 2) * 2
const evenDown = (n: number): number => Math.floor(n / 2) * 2
const evenUp = (n: number): number => Math.ceil(n / 2) * 2

export interface Frame {
  width: number
  height: number
  /** The frame was sized from the picture itself, so nothing is scaled. */
  native: boolean
}

export interface Picture {
  width: number
  height: number
}

/**
 * The output frame for an aspect. With `shortSide` (1080, 720, ...) the frame is
 * that many pixels on its short side. Without it the frame is native: the largest
 * box of that aspect inside the picture (after the width squeeze), divided by the
 * zoom when zooming in. Zooming out never grows a native frame; the picture shrinks
 * inside it instead.
 */
export function frameFor(
  aspect: FrameAspect,
  picture: Picture,
  shortSide?: number,
  zoom = 1,
  widthScale = 1
): Frame {
  const ratio = FRAME_RATIOS[aspect] ?? FRAME_RATIOS[DEFAULT_FRAME_ASPECT]
  if (shortSide) {
    return ratio < 1
      ? {
          width: even(shortSide),
          height: even(shortSide / ratio),
          native: false,
        }
      : {
          width: even(shortSide * ratio),
          height: even(shortSide),
          native: false,
        }
  }
  const pw = picture.width * clampWidth(widthScale)
  const ph = picture.height
  const wide = pw / ph > ratio
  const z = Math.max(1, clampZoom(zoom))
  const w = wide ? ph * ratio : pw
  const h = wide ? ph : pw / ratio
  return { width: evenDown(w / z), height: evenDown(h / z), native: true }
}

export interface Placement {
  /** The picture after the width squeeze, the fill scale and the zoom. */
  width: number
  height: number
  /** The part of it that lands in the frame, and where it is cut from. */
  cropW: number
  cropH: number
  cropX: number
  cropY: number
  /** Where that part sits in the frame. */
  padX: number
  padY: number
  /** True when the picture covers the whole frame. */
  covers: boolean
}

/**
 * Where the picture goes in the frame. At zoom 1 and width 100 % the picture is
 * scaled so it just covers the frame, then the window at `focus` is cut out. Zoom
 * grows or shrinks it from there; below 1 it stops covering the frame and the
 * background shows. Focus places the window over the picture, and the picture
 * inside the frame, 0..1 from the left and top.
 */
export function placePicture(
  frame: Frame,
  picture: Picture,
  zoom = 1,
  widthScale = 1,
  focus: { x: number; y: number } = { x: 0.5, y: 0.5 }
): Placement {
  const k = clampWidth(widthScale)
  const z = clampZoom(zoom)
  const pw = picture.width * k
  const ph = picture.height
  const s = Math.max(frame.width / pw, frame.height / ph)
  const width = Math.max(2, even(pw * s * z))
  const height = Math.max(2, even(ph * s * z))
  const cropW = Math.min(width, frame.width)
  const cropH = Math.min(height, frame.height)
  const fx = clamp01(focus.x)
  const fy = clamp01(focus.y)
  return {
    width,
    height,
    cropW,
    cropH,
    cropX: even((width - cropW) * fx),
    cropY: even((height - cropH) * fy),
    padX: even((frame.width - cropW) * fx),
    padY: even((frame.height - cropH) * fy),
    covers: cropW === frame.width && cropH === frame.height,
  }
}

/**
 * Width to downscale to before tone-mapping so the expensive filters run at
 * the size the placement needs rather than at source size. Undefined when the
 * source is already no bigger than that.
 */
export function framePrescaleWidth(
  placement: Placement,
  picture: Picture,
  widthScale = 1
): number | undefined {
  const k = clampWidth(widthScale)
  const wanted = evenUp(
    Math.max(
      placement.width / k,
      (placement.height * picture.width) / picture.height
    )
  )
  return wanted < picture.width ? wanted : undefined
}

export interface FrameOptions {
  /** Output aspect; 9:16 when omitted. */
  aspect?: FrameAspect
  /** Short side of the output in pixels; omit for a native frame with no scaling. */
  shortSide?: number
  /** Picture rectangle without the black bars; applied before scaling. */
  bars?: Crop
  /** Where the window sits over the picture, 0..1 from the left/top; 0.5 is centred. */
  focus?: { x: number; y: number }
  /** 1 covers the frame exactly; above it crops tighter, below it shows the background. */
  zoom?: number
  /** Horizontal squeeze or stretch of the picture; 1 is its real width. */
  widthScale?: number
  /** What fills the frame around the picture; blur when omitted. */
  background?: FrameBackground
}

/** Blurred, enlarged copy of the picture filling the frame. Blur a small copy and scale it back up: same look, a fraction of the cost. */
const blurBackground = ({ width: W, height: H }: Frame): string => {
  const w = even(W / 4)
  const h = even(H / 4)
  return `scale=w=${w}:h=${h}:force_original_aspect_ratio=increase:flags=bicubic,crop=w=${w}:h=${h},gblur=sigma=8,scale=w=${W}:h=${H}:flags=bicubic`
}

/** Squeeze, scale and cut the picture; then pad or overlay it when it does not cover the frame. */
function placementChain(
  frame: Frame,
  p: Placement,
  background: FrameBackground
): string {
  // A non-uniform scale would otherwise keep the display aspect by changing the SAR.
  const fg = `scale=w=${p.width}:h=${p.height}:flags=lanczos,setsar=1,crop=w=${p.cropW}:h=${p.cropH}:x=${p.cropX}:y=${p.cropY}`
  if (p.covers) return fg
  if (background === "black")
    return `${fg},pad=w=${frame.width}:h=${frame.height}:x=${p.padX}:y=${p.padY}:color=black`
  return [
    "split[bg][fg]",
    `[bg]${blurBackground(frame)}[bgb]`,
    `[fg]${fg}[fgs]`,
    `[bgb][fgs]overlay=x=${p.padX}:y=${p.padY}:format=yuv420,format=yuv420p`,
  ].join(";")
}

/** Framed output: drop the bars, place the picture, fill the rest with the background. */
export function frameFilters(
  probe: ProbeResult,
  opts: FrameOptions = {}
): string {
  const v = probe.video
  const sar = v?.sar ?? 1
  const picture: Picture = opts.bars
    ? { width: opts.bars.w * sar, height: opts.bars.h }
    : { width: v?.displayWidth ?? 1920, height: v?.height ?? 1080 }
  const frame = frameFor(
    opts.aspect ?? DEFAULT_FRAME_ASPECT,
    picture,
    opts.shortSide,
    opts.zoom,
    opts.widthScale
  )
  const placement = placePicture(
    frame,
    picture,
    opts.zoom,
    opts.widthScale,
    opts.focus
  )
  return [
    ...prepFilters(
      probe,
      "field",
      framePrescaleWidth(placement, picture, opts.widthScale),
      opts.bars
    ),
    "format=yuv420p",
    placementChain(frame, placement, opts.background ?? "blur"),
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

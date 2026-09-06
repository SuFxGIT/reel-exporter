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
// Framed output: the picture fitted into a fixed aspect (9:16, 1:1, 16:9, ...)
// ---------------------------------------------------------------------------

export type FrameFit = "blur" | "crop" | "bars" | "stretch"
export type FrameAspect = "9:16" | "4:5" | "1:1" | "4:3" | "16:9"
export const FRAME_ASPECTS: FrameAspect[] = [
  "9:16",
  "4:5",
  "1:1",
  "4:3",
  "16:9",
]
export const DEFAULT_FRAME_ASPECT: FrameAspect = "9:16"

const FRAME_RATIOS: Record<FrameAspect, number> = {
  "9:16": 9 / 16,
  "4:5": 4 / 5,
  "1:1": 1,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
}

export const MAX_CROP_ZOOM = 4
const clampZoom = (z: number | undefined): number =>
  Number.isFinite(z) ? Math.min(MAX_CROP_ZOOM, Math.max(1, z as number)) : 1

const fraction = (n: number): string => Math.min(1, Math.max(0, n)).toFixed(3)
const even = (n: number): number => Math.round(n / 2) * 2
const evenDown = (n: number): number => Math.floor(n / 2) * 2
const evenUp = (n: number): number => Math.ceil(n / 2) * 2

export interface Frame {
  width: number
  height: number
  /** The frame was sized from the picture itself, so nothing is scaled. */
  native: boolean
}

/**
 * The output frame for an aspect. With `shortSide` (1080, 720, ...) the frame is
 * that many pixels on its short side. Without it the frame is native: for the
 * crop fit it is the largest box of that aspect inside the picture (divided by
 * `zoom`), for blur and bars the smallest box that contains the picture.
 */
export function frameFor(
  aspect: FrameAspect,
  fit: FrameFit,
  picture: { width: number; height: number },
  shortSide?: number,
  zoom = 1
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
  const wide = picture.width / picture.height > ratio
  if (fit === "crop" || fit === "stretch") {
    // The largest box of the aspect inside the picture: the crop window, or
    // what a stretch squeezes the picture into (the long side gets shorter).
    const z = fit === "crop" ? clampZoom(zoom) : 1
    const w = wide ? picture.height * ratio : picture.width
    const h = wide ? picture.height : picture.width / ratio
    return { width: evenDown(w / z), height: evenDown(h / z), native: true }
  }
  const w = wide ? picture.width : picture.height * ratio
  const h = wide ? picture.width / ratio : picture.height
  return { width: evenUp(w), height: evenUp(h), native: true }
}

/**
 * Width to downscale to before tone-mapping so the expensive filters run at
 * the size the frame needs rather than at source size. Native frames never scale.
 */
export function framePrescaleWidth(
  probe: ProbeResult,
  fit: FrameFit,
  frame: Frame,
  picture?: { width: number; height: number },
  zoom = 1
): number | undefined {
  if (frame.native) return undefined
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

export interface FrameOptions {
  /** Output aspect; 9:16 when omitted. */
  aspect?: FrameAspect
  /** Short side of the output in pixels; omit for a native frame with no scaling. */
  shortSide?: number
  /** Picture rectangle without the black bars; applied before scaling. */
  bars?: Crop
  /** Where the crop window sits, 0..1 from the left/top; 0.5 is centred. */
  focus?: { x: number; y: number }
  /** Crop fit only: how much tighter than the widest window; 1 is the whole picture. */
  zoom?: number
}

/** Picture centred over a blurred copy. Blur a small copy and scale it back up: same look, a fraction of the cost. */
const blurFit = ({ width: W, height: H }: Frame): string => {
  const w = even(W / 4)
  const h = even(H / 4)
  return [
    "split[bg][fg]",
    `[bg]scale=w=${w}:h=${h}:force_original_aspect_ratio=increase:flags=bicubic,crop=w=${w}:h=${h},gblur=sigma=8,scale=w=${W}:h=${H}:flags=bicubic[bgb]`,
    `[fg]scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fgs]`,
    "[bgb][fgs]overlay=x=(W-w)/2:y=(H-h)/2:format=yuv420,format=yuv420p",
  ].join(";")
}

/** Picture squeezed to the frame: no crop, no bars, the shape changes. */
const stretchFit = ({ width: W, height: H }: Frame): string =>
  `scale=w=${W}:h=${H}:flags=lanczos,setsar=1`

/** Picture centred on black. */
const barsFit = ({ width: W, height: H }: Frame): string =>
  `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=w=${W}:h=${H}:x=(ow-iw)/2:y=(oh-ih)/2:color=black`

/**
 * Fill the frame, then cut the window at the chosen position. Zoom scales the
 * picture past the frame so the window covers 1/zoom of it; the crop stays the
 * frame size, so the aspect ratio never changes. A native frame is already the
 * window, so it is cut straight out of the picture.
 */
const cropFit = (
  { width: W, height: H, native }: Frame,
  focus: { x: number; y: number } = { x: 0.5, y: 0.5 },
  zoom = 1
): string => {
  const window = `crop=w=${W}:h=${H}:x=(iw-${W})*${fraction(focus.x)}:y=(ih-${H})*${fraction(focus.y)}`
  if (native) return window
  const z = clampZoom(zoom)
  return `scale=w=${even(W * z)}:h=${even(H * z)}:force_original_aspect_ratio=increase:flags=lanczos,${window}`
}

/** Framed output: drop the bars, fit the picture, fill the frame. */
export function frameFilters(
  probe: ProbeResult,
  fit: FrameFit,
  opts: FrameOptions = {}
): string {
  const v = probe.video
  const sar = v?.sar ?? 1
  const picture = opts.bars
    ? { width: opts.bars.w * sar, height: opts.bars.h }
    : { width: v?.displayWidth ?? 1920, height: v?.height ?? 1080 }
  const frame = frameFor(
    opts.aspect ?? DEFAULT_FRAME_ASPECT,
    fit,
    picture,
    opts.shortSide,
    opts.zoom
  )
  return [
    ...prepFilters(
      probe,
      "field",
      framePrescaleWidth(
        probe,
        fit,
        frame,
        opts.bars ? picture : undefined,
        opts.zoom
      ),
      opts.bars
    ),
    "format=yuv420p",
    fit === "crop"
      ? cropFit(frame, opts.focus, opts.zoom)
      : fit === "blur"
        ? blurFit(frame)
        : fit === "stretch"
          ? stretchFit(frame)
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

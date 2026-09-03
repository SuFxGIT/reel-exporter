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

function squarePixels(probe: ProbeResult): string | null {
  const sar = probe.video?.sar ?? 1
  return Math.abs(sar - 1) > 0.01
    ? "scale=w=iw*sar:h=ih:flags=bicubic,setsar=1"
    : null
}

/** Preview stream: deinterlace, downscale to the preview width, tone-map, 8-bit 4:2:0. */
export function previewFilters(probe: ProbeResult): string {
  const parts: string[] = []
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

/** Full-resolution output (screenshots, clips). */
export function fullResFilters(
  probe: ProbeResult,
  pixelFormat: "yuv420p" | "rgb24" | "yuvj420p",
  deinterlaceMode: "frame" | "field",
  maxWidth?: number
): string {
  const parts: string[] = []
  const de = deinterlaceFilter(probe, deinterlaceMode)
  if (de) parts.push(de)
  if (maxWidth && probe.video && maxWidth < probe.video.displayWidth) {
    // Downscale before tone-mapping: that is where the cost is.
    parts.push(
      `scale=w='min(${maxWidth},iw*sar)':h=-2:flags=lanczos`,
      "setsar=1"
    )
  } else {
    const sq = squarePixels(probe)
    if (sq) parts.push(sq)
  }
  const tm = tonemapChain(probe)
  if (tm) parts.push(tm)
  parts.push(`format=${pixelFormat}`)
  return parts.join(",")
}

/** Small preview frame (hover thumbnails, capture thumbnails). */
export function thumbnailFilters(probe: ProbeResult, width: number): string {
  const parts: string[] = []
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

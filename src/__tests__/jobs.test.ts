import { describe, expect, it } from "vitest"
import { exportArgs, palettePathFor } from "../media/jobs.js"
import type { ProbeResult } from "../media/probe.js"

const probe = (extra: Record<string, unknown> = {}): ProbeResult =>
  ({
    isLegacy: false,
    hasVideo: true,
    audio: [{ index: 0 }],
    hdr: { tonemap: false, kind: "sdr" },
    video: {
      interlaced: false,
      sar: 1,
      displayWidth: 1920,
      height: 1080,
      colorTransfer: "bt709",
    },
    ...extra,
  }) as unknown as ProbeResult

const base = { start: 10, end: 15, audio: 0, quality: "balanced" as const }
/** A plain video export: source aspect, bars trimmed, no width limit. */
const video = {
  format: "mp4" as const,
  aspect: "source" as const,
  fit: "blur" as const,
  trimBars: true,
}
const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe("exportArgs", () => {
  it("builds the MP4 clip as before", () => {
    const a = exportArgs(
      "/m/a.mkv",
      probe(),
      { ...base, ...video },
      "/o/x.tmp.mp4"
    )
    expect(a.slice(-2)).toEqual(["mp4", "/o/x.tmp.mp4"])
    expect(at(a, "-ss")).toBe("10.000")
    // Input-side -t limits reading; output-side -t trims exactly.
    expect(a.indexOf("-t")).toBeLessThan(a.indexOf("-i"))
    expect(at(a, "-t")).toBe("5.000")
    expect(a.lastIndexOf("-t")).toBeGreaterThan(a.indexOf("-i"))
    expect(at(a, "-vf")).toBe("format=yuv420p")
    expect(at(a, "-c:v")).toBe("libx264")
    expect(at(a, "-crf")).toBe("20")
    expect(at(a, "-c:a")).toBe("aac")
    expect(a).toContain("+faststart")
  })

  it("builds a framed MP4 with the fit chain", () => {
    const a = exportArgs(
      "/m/a.mkv",
      probe(),
      {
        ...base,
        ...video,
        aspect: "9:16",
        shortSide: 1080,
        fit: "bars",
        audio: -1,
      },
      "/o/x.tmp.mp4"
    )
    expect(at(a, "-vf")).toContain("pad=w=1080:h=1920")
    expect(at(a, "-f")).toBe("mp4")
    expect(a).not.toContain("-c:a")
    expect(a).not.toContain("0:a:0")
  })

  it("drops detected bars before the fit and honours the crop focus", () => {
    const a = exportArgs(
      "/m/a.mkv",
      probe(),
      {
        ...base,
        ...video,
        aspect: "9:16",
        shortSide: 1080,
        fit: "crop",
        focus: { x: 0.25, y: 0.5 },
        audio: -1,
      },
      "/o/x.tmp.mp4",
      1,
      { bars: { w: 1920, h: 800, x: 0, y: 140 } }
    )
    const vf = at(a, "-vf")
    expect(vf.indexOf("crop=w=1920:h=800:x=0:y=140")).toBeLessThan(
      vf.indexOf("scale=w=1080")
    )
    expect(vf.endsWith("x=(iw-1080)*0.250:y=(ih-1920)*0.500")).toBe(true)
  })

  it("passes the crop zoom through to the fill scale", () => {
    const a = exportArgs(
      "/m/a.mkv",
      probe(),
      {
        ...base,
        ...video,
        aspect: "9:16",
        shortSide: 1080,
        fit: "crop",
        focus: { x: 0.5, y: 0.5 },
        zoom: 1.5,
        audio: -1,
      },
      "/o/x.tmp.mp4"
    )
    const vf = at(a, "-vf")
    expect(vf).toContain(
      "scale=w=1620:h=2880:force_original_aspect_ratio=increase"
    )
    expect(
      vf.endsWith("crop=w=1080:h=1920:x=(iw-1080)*0.500:y=(ih-1920)*0.500")
    ).toBe(true)
  })

  it("trims bars from a source-aspect export and keeps the width limit", () => {
    const bars = { w: 1920, h: 800, x: 0, y: 140 }
    const plain = exportArgs(
      "/m/a.mkv",
      probe(),
      { ...base, ...video, audio: -1 },
      "/o/x.tmp.mp4",
      1,
      { bars }
    )
    expect(at(plain, "-vf")).toBe("crop=w=1920:h=800:x=0:y=140,format=yuv420p")
    const limited = exportArgs(
      "/m/a.mkv",
      probe(),
      { ...base, ...video, maxWidth: 1280, audio: -1 },
      "/o/x.tmp.mp4",
      1,
      { bars }
    )
    expect(at(limited, "-vf")).toBe(
      "crop=w=1920:h=800:x=0:y=140,scale=w='min(1280,iw*sar)':h=-2:flags=lanczos,setsar=1,format=yuv420p"
    )
  })

  it("crops a native frame without any scale step", () => {
    const a = exportArgs(
      "/m/a.mkv",
      probe(),
      { ...base, ...video, aspect: "1:1", fit: "crop", audio: -1 },
      "/o/x.tmp.mp4"
    )
    const vf = at(a, "-vf")
    expect(
      vf.endsWith("crop=w=1080:h=1080:x=(iw-1080)*0.500:y=(ih-1080)*0.500")
    ).toBe(true)
    expect(vf).not.toContain("force_original_aspect_ratio")
  })

  it("builds a two-pass GIF without audio", () => {
    const p = {
      ...base,
      format: "gif" as const,
      fps: 15,
      width: 480,
      audio: -1,
    }
    const one = exportArgs("/m/a.mkv", probe(), p, "/o/x.tmp.gif", 1)
    expect(at(one, "-vf")).toBe(
      "fps=15,scale=w='min(480,iw*sar)':h=-2:flags=lanczos,setsar=1,palettegen=stats_mode=full"
    )
    expect(one[one.length - 1]).toBe(palettePathFor("/o/x.tmp.gif"))
    expect(one.indexOf("-t")).toBeLessThan(one.indexOf("-i"))
    const two = exportArgs("/m/a.mkv", probe(), p, "/o/x.tmp.gif", 2)
    // The palette input must not inherit the duration limit; the output gets its own.
    const palette = two.indexOf(palettePathFor("/o/x.tmp.gif"))
    expect(two[palette - 1]).toBe("-i")
    expect(two[palette - 2]).not.toBe("5.000")
    expect(two.lastIndexOf("-t")).toBeGreaterThan(palette)
    expect(at(two, "-filter_complex")).toBe(
      "[0:V:0]fps=15,scale=w='min(480,iw*sar)':h=-2:flags=lanczos,setsar=1[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
    )
    expect(two).toContain("-an")
    expect(two.slice(-2)).toEqual(["gif", "/o/x.tmp.gif"])
    expect(two).not.toContain("-c:a")
    expect(two).not.toContain("libx264")
  })
})

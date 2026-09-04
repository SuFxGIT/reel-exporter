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
const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe("exportArgs", () => {
  it("builds the MP4 clip as before", () => {
    const a = exportArgs(
      "/m/a.mkv",
      probe(),
      { ...base, format: "mp4" },
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

  it("builds a vertical Shorts MP4 with the fit chain", () => {
    const a = exportArgs(
      "/m/a.mkv",
      probe(),
      { ...base, format: "shorts", fit: "bars", audio: -1 },
      "/o/x.tmp.mp4"
    )
    expect(at(a, "-vf")).toContain("pad=w=1080:h=1920")
    expect(at(a, "-f")).toBe("mp4")
    expect(a).not.toContain("-c:a")
    expect(a).not.toContain("0:a:0")
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

import { describe, expect, it } from "vitest"
import {
  colorFixup,
  fullResFilters,
  gifFilters,
  previewFilters,
  shortsFilters,
  shortsPrescaleWidth,
  thumbnailFilters,
} from "../media/filters.js"
import type { ProbeResult } from "../media/probe.js"

const probe = (video: Record<string, unknown>, hdr = {}): ProbeResult =>
  ({
    isLegacy: false,
    hdr: { tonemap: false, kind: "sdr", ...hdr },
    video: {
      interlaced: false,
      sar: 1,
      displayWidth: 4096,
      ...video,
    },
  }) as unknown as ProbeResult

describe("colorFixup", () => {
  it("tags SDR frames with a missing or reserved transfer as BT.709", () => {
    expect(colorFixup(probe({ colorTransfer: undefined }))).toBe(
      "setparams=color_trc=bt709"
    )
    expect(colorFixup(probe({ colorTransfer: "unknown" }))).toBe(
      "setparams=color_trc=bt709"
    )
    expect(colorFixup(probe({ colorTransfer: "reserved" }))).toBe(
      "setparams=color_trc=bt709"
    )
  })

  it("leaves tagged SDR and every HDR source alone", () => {
    expect(colorFixup(probe({ colorTransfer: "bt709" }))).toBeNull()
    expect(
      colorFixup(
        probe({ colorTransfer: "smpte2084" }, { tonemap: true, kind: "pq" })
      )
    ).toBeNull()
  })

  it("runs first in every chain", () => {
    const p = probe({})
    expect(previewFilters(p).startsWith("setparams=color_trc=bt709,")).toBe(
      true
    )
    expect(
      fullResFilters(p, "yuvj420p", "frame", 640).startsWith(
        "setparams=color_trc=bt709,"
      )
    ).toBe(true)
    expect(
      thumbnailFilters(p, 320).startsWith("setparams=color_trc=bt709,")
    ).toBe(true)
    expect(previewFilters(probe({ colorTransfer: "bt709" }))).not.toContain(
      "setparams"
    )
  })

  it("converts inside an explicit scale when nothing else scales", () => {
    expect(fullResFilters(probe({}), "rgb24", "frame")).toBe(
      "setparams=color_trc=bt709,scale=w=iw:h=ih,format=rgb24"
    )
    expect(
      fullResFilters(probe({ colorTransfer: "bt709" }), "rgb24", "frame")
    ).toBe("format=rgb24")
  })
})

const sdr = (width: number, height: number) =>
  probe({ colorTransfer: "bt709", displayWidth: width, height })
const hdr = probe(
  { colorTransfer: "smpte2084", displayWidth: 3840, height: 2160 },
  { tonemap: true, kind: "pq" }
)

describe("shortsPrescaleWidth", () => {
  it("downscales to the box the fit needs, never upscales", () => {
    expect(shortsPrescaleWidth(sdr(3840, 2160), "blur")).toBe(3413)
    expect(shortsPrescaleWidth(sdr(3840, 2160), "crop")).toBe(3413)
    expect(shortsPrescaleWidth(sdr(3840, 2160), "bars")).toBe(1080)
    expect(shortsPrescaleWidth(sdr(1920, 1080), "bars")).toBe(1080)
    expect(shortsPrescaleWidth(sdr(1920, 1080), "blur")).toBeUndefined()
    expect(shortsPrescaleWidth(sdr(1080, 1920), "blur")).toBeUndefined()
    expect(shortsPrescaleWidth(sdr(1080, 1920), "bars")).toBeUndefined()
  })
})

describe("shortsFilters", () => {
  it("fixes colour first, tone-maps HDR before compositing, then fills 1080x1920", () => {
    const blur = shortsFilters(
      probe({ displayWidth: 3840, height: 2160 }),
      "blur"
    )
    expect(blur.startsWith("setparams=color_trc=bt709,")).toBe(true)
    expect(blur).toContain(",format=yuv420p,split[bg][fg];")
    expect(
      blur.endsWith("overlay=x=(W-w)/2:y=(H-h)/2:format=yuv420,format=yuv420p")
    ).toBe(true)
    const crop = shortsFilters(hdr, "crop")
    expect(crop.indexOf("tonemap=")).toBeLessThan(crop.indexOf("crop=w=1080"))
    expect(crop.endsWith("crop=w=1080:h=1920")).toBe(true)
    const bars = shortsFilters(sdr(1920, 1080), "bars")
    expect(
      bars.endsWith("pad=w=1080:h=1920:x=(ow-iw)/2:y=(oh-ih)/2:color=black")
    ).toBe(true)
    expect(bars).toContain("scale=w='min(1080,iw*sar)':h=-2:flags=lanczos")
  })
})

describe("gifFilters", () => {
  it("reduces the frame rate before scaling and keeps the fixup first", () => {
    const g = gifFilters(probe({}), { fps: 15, width: 480 })
    expect(g).toBe(
      "setparams=color_trc=bt709,fps=15,scale=w='min(480,iw*sar)':h=-2:flags=lanczos,setsar=1"
    )
    expect(gifFilters(hdr, { fps: 10, width: 320 })).toContain(
      "fps=10,scale=w='min(320,iw*sar)':h=-2:flags=lanczos,setsar=1,zscale="
    )
  })
})

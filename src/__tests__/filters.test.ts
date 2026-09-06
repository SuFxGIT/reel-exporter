import { describe, expect, it } from "vitest"
import {
  colorFixup,
  fullResFilters,
  gifFilters,
  previewFilters,
  frameFilters,
  frameFor,
  framePrescaleWidth,
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

const F = (
  aspect: "9:16" | "4:5" | "1:1" | "4:3" | "16:9",
  fit: "blur" | "crop" | "bars",
  short = 1080
) => frameFor(aspect, fit, { width: 3840, height: 2160 }, short)

describe("frameFor", () => {
  it("sizes fixed frames from the short side", () => {
    expect(F("9:16", "crop")).toEqual({
      width: 1080,
      height: 1920,
      native: false,
    })
    expect(F("4:5", "crop")).toEqual({
      width: 1080,
      height: 1350,
      native: false,
    })
    expect(F("1:1", "crop")).toEqual({
      width: 1080,
      height: 1080,
      native: false,
    })
    expect(F("4:3", "crop")).toEqual({
      width: 1440,
      height: 1080,
      native: false,
    })
    expect(F("16:9", "crop")).toEqual({
      width: 1920,
      height: 1080,
      native: false,
    })
    expect(F("9:16", "blur", 720)).toEqual({
      width: 720,
      height: 1280,
      native: false,
    })
    expect(F("4:3", "bars", 720)).toEqual({
      width: 960,
      height: 720,
      native: false,
    })
  })

  it("sizes native frames from the picture", () => {
    const pic = { width: 3840, height: 1608 }
    // Crop: the largest 9:16 box inside a 3840x1608 picture is 904x1608 (rounded down to even).
    expect(frameFor("9:16", "crop", pic)).toEqual({
      width: 904,
      height: 1608,
      native: true,
    })
    expect(frameFor("9:16", "crop", pic, undefined, 2)).toEqual({
      width: 452,
      height: 804,
      native: true,
    })
    expect(frameFor("16:9", "crop", pic)).toEqual({
      width: 2858,
      height: 1608,
      native: true,
    })
    // Blur and bars: the smallest 9:16 box around the picture.
    expect(frameFor("9:16", "blur", pic)).toEqual({
      width: 3840,
      height: 6828,
      native: true,
    })
    expect(frameFor("1:1", "bars", pic)).toEqual({
      width: 3840,
      height: 3840,
      native: true,
    })
    expect(frameFor("16:9", "bars", { width: 1080, height: 1920 })).toEqual({
      width: 3414,
      height: 1920,
      native: true,
    })
  })
})

describe("framePrescaleWidth", () => {
  it("downscales to the box the fit needs, never upscales", () => {
    // 3413 rounded up to an even width for 4:2:0 output.
    expect(framePrescaleWidth(sdr(3840, 2160), "blur", F("9:16", "blur"))).toBe(
      3414
    )
    expect(framePrescaleWidth(sdr(3840, 2160), "crop", F("9:16", "crop"))).toBe(
      3414
    )
    expect(framePrescaleWidth(sdr(3840, 2160), "bars", F("9:16", "bars"))).toBe(
      1080
    )
    expect(framePrescaleWidth(sdr(1920, 1080), "bars", F("9:16", "bars"))).toBe(
      1080
    )
    expect(
      framePrescaleWidth(sdr(1920, 1080), "blur", F("9:16", "blur"))
    ).toBeUndefined()
    expect(
      framePrescaleWidth(sdr(1080, 1920), "blur", F("9:16", "blur"))
    ).toBeUndefined()
    expect(
      framePrescaleWidth(sdr(1080, 1920), "bars", F("9:16", "bars"))
    ).toBeUndefined()
    expect(
      framePrescaleWidth(
        sdr(3840, 2160),
        "crop",
        frameFor("9:16", "crop", { width: 3840, height: 2160 })
      )
    ).toBeUndefined()
  })
})

const at1080 = { shortSide: 1080 }

describe("frameFilters", () => {
  it("fixes colour first, tone-maps HDR before compositing, then fills 1080x1920", () => {
    const blur = frameFilters(
      probe({ displayWidth: 3840, height: 2160 }),
      "blur",
      at1080
    )
    expect(blur.startsWith("setparams=color_trc=bt709,")).toBe(true)
    expect(blur).toContain(",format=yuv420p,split[bg][fg];")
    expect(
      blur.endsWith("overlay=x=(W-w)/2:y=(H-h)/2:format=yuv420,format=yuv420p")
    ).toBe(true)
    const crop = frameFilters(hdr, "crop", at1080)
    expect(crop.indexOf("tonemap=")).toBeLessThan(crop.indexOf("crop=w=1080"))
    expect(
      crop.endsWith("crop=w=1080:h=1920:x=(iw-1080)*0.500:y=(ih-1920)*0.500")
    ).toBe(true)
    const bars = frameFilters(sdr(1920, 1080), "bars", at1080)
    expect(
      bars.endsWith("pad=w=1080:h=1920:x=(ow-iw)/2:y=(oh-ih)/2:color=black")
    ).toBe(true)
    expect(bars).toContain("scale=w='min(1080,iw*sar)':h=-2:flags=lanczos")
  })

  it("cuts a native crop straight out of the picture without scaling", () => {
    const s = frameFilters(sdr(3840, 2160), "crop", {
      aspect: "9:16",
      focus: { x: 0.25, y: 0.5 },
      zoom: 2,
    })
    // Largest 9:16 box in 3840x2160 is 1215x2160; at zoom 2 the window is 606x1080.
    expect(s).toBe(
      "format=yuv420p,crop=w=606:h=1080:x=(iw-606)*0.250:y=(ih-1080)*0.500"
    )
    const boxed = frameFilters(sdr(3840, 2160), "crop", {
      aspect: "1:1",
      bars: { w: 3840, h: 1608, x: 0, y: 276 },
    })
    expect(boxed).toBe(
      "crop=w=3840:h=1608:x=0:y=276,format=yuv420p,crop=w=1608:h=1608:x=(iw-1608)*0.500:y=(ih-1608)*0.500"
    )
    const native = frameFilters(sdr(1920, 1080), "bars", { aspect: "9:16" })
    expect(native).toContain("pad=w=1920:h=3414:")
    expect(native).not.toContain("scale=w='min(")
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

describe("frameFilters with bars and a focus", () => {
  const boxed = sdr(3840, 2160)
  const bars = { w: 3840, h: 1608, x: 0, y: 276 }

  it("crops the bars before scaling and sizes the downscale to the picture", () => {
    const s = frameFilters(boxed, "bars", { shortSide: 1080, bars })
    const cropAt = s.indexOf("crop=w=3840:h=1608:x=0:y=276")
    expect(cropAt).toBeGreaterThan(-1)
    expect(cropAt).toBeLessThan(s.indexOf("scale="))
    // Picture is 3840x1608: at 1920 tall it would be 4585 wide, so bars fit 1080 wide.
    expect(s).toContain("scale=w='min(1080,iw*sar)':h=-2:flags=lanczos")
    expect(
      framePrescaleWidth(boxed, "blur", F("9:16", "blur"), {
        width: 3840,
        height: 1608,
      })
    ).toBe(undefined)
  })

  it("places the crop window where the focus says", () => {
    const left = frameFilters(boxed, "crop", {
      shortSide: 1080,
      focus: { x: 0, y: 0.5 },
    })
    expect(left.endsWith("x=(iw-1080)*0.000:y=(ih-1920)*0.500")).toBe(true)
    const right = frameFilters(boxed, "crop", {
      shortSide: 1080,
      bars,
      focus: { x: 1, y: 0.5 },
    })
    expect(right.endsWith("x=(iw-1080)*1.000:y=(ih-1920)*0.500")).toBe(true)
    expect(right).toContain("crop=w=3840:h=1608:x=0:y=276")
    expect(
      frameFilters(boxed, "blur", { shortSide: 1080, focus: { x: 0, y: 0 } })
    ).not.toContain("*0.000")
  })

  it("zooms by filling past the frame and keeps the 1080x1920 crop", () => {
    const zoomed = frameFilters(boxed, "crop", {
      shortSide: 1080,
      bars,
      focus: { x: 0.25, y: 0.5 },
      zoom: 2,
    })
    expect(zoomed).toContain(
      "scale=w=2160:h=3840:force_original_aspect_ratio=increase:flags=lanczos,crop=w=1080:h=1920:x=(iw-1080)*0.250:y=(ih-1920)*0.500"
    )
    // 3840x1608 at 1920 tall is 4585 wide; the picture is smaller so it is not prescaled.
    expect(zoomed).not.toContain("scale=w='min(")
    expect(
      framePrescaleWidth(
        sdr(3840, 2160),
        "crop",
        F("9:16", "crop"),
        undefined,
        2
      )
    ).toBeUndefined()
    // 4K at zoom 1 prescales to 3414; zoom 1.05 needs 3584.
    expect(
      framePrescaleWidth(
        sdr(3840, 2160),
        "crop",
        F("9:16", "crop"),
        undefined,
        1.05
      )
    ).toBe(3584)
    // Out-of-range zoom is clamped, and 1 is byte-identical to no zoom.
    expect(frameFilters(boxed, "crop", { shortSide: 1080, zoom: 1 })).toBe(
      frameFilters(boxed, "crop", at1080)
    )
    expect(frameFilters(boxed, "crop", { shortSide: 1080, zoom: 0.5 })).toBe(
      frameFilters(boxed, "crop", at1080)
    )
    expect(
      frameFilters(boxed, "crop", { shortSide: 1080, zoom: 99 })
    ).toContain("scale=w=4320:h=7680:")
  })
})

describe("frameFilters with another aspect", () => {
  it("sizes every fit to the chosen frame", () => {
    const src = sdr(3840, 2160)
    expect(
      frameFilters(src, "bars", { shortSide: 1080, aspect: "1:1" })
    ).toContain("pad=w=1080:h=1080:")
    expect(
      frameFilters(src, "bars", { shortSide: 1080, aspect: "1:1" })
    ).toContain("scale=w='min(1080,iw*sar)'")
    const blur = frameFilters(src, "blur", { shortSide: 1080, aspect: "4:5" })
    expect(blur).toContain("scale=w=270:h=338:")
    expect(blur).toContain("scale=w=1080:h=1350:flags=bicubic[bgb]")
    const crop = frameFilters(src, "crop", {
      shortSide: 1080,
      aspect: "16:9",
      focus: { x: 0.5, y: 0 },
      zoom: 2,
    })
    expect(crop).toContain(
      "scale=w=3840:h=2160:force_original_aspect_ratio=increase:flags=lanczos,crop=w=1920:h=1080:x=(iw-1920)*0.500:y=(ih-1080)*0.000"
    )
    // 4K into a 16:9 frame at zoom 2 needs 3840 wide, so no prescale.
    expect(crop).not.toContain("scale=w='min(")
    expect(
      frameFilters(src, "crop", { shortSide: 1080, aspect: "16:9" })
    ).toContain("scale=w='min(1920,iw*sar)'")
    expect(frameFilters(src, "crop", at1080)).toBe(
      frameFilters(src, "crop", { shortSide: 1080, aspect: "9:16" })
    )
  })
})

describe("frameFilters with the stretch fit", () => {
  it("squeezes the picture to the frame without cropping", () => {
    const fixed = frameFilters(sdr(3840, 2160), "stretch", {
      aspect: "9:16",
      shortSide: 1080,
    })
    expect(
      fixed.endsWith(
        "format=yuv420p,scale=w=1080:h=1920:flags=lanczos,setsar=1"
      )
    ).toBe(true)
    expect(fixed).toContain("scale=w='min(3414,iw*sar)'")
    // Native: keep the height, shrink the width to the aspect.
    const native = frameFilters(sdr(3840, 2160), "stretch", { aspect: "9:16" })
    expect(native).toBe(
      "format=yuv420p,scale=w=1214:h=2160:flags=lanczos,setsar=1"
    )
    expect(
      frameFor("9:16", "stretch", { width: 3840, height: 2160 }, undefined, 3)
    ).toEqual({
      width: 1214,
      height: 2160,
      native: true,
    })
  })
})

import { describe, expect, it } from "vitest"
import {
  colorFixup,
  fullResFilters,
  gifFilters,
  previewFilters,
  frameFilters,
  frameFor,
  framePrescaleWidth,
  placePicture,
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

const pic4k = { width: 3840, height: 2160 }
const F = (aspect: "9:16" | "4:5" | "1:1" | "4:3" | "16:9", short = 1080) =>
  frameFor(aspect, pic4k, short)

describe("frameFor", () => {
  it("sizes fixed frames from the short side", () => {
    expect(F("9:16")).toEqual({ width: 1080, height: 1920, native: false })
    expect(F("4:5")).toEqual({ width: 1080, height: 1350, native: false })
    expect(F("1:1")).toEqual({ width: 1080, height: 1080, native: false })
    expect(F("4:3")).toEqual({ width: 1440, height: 1080, native: false })
    expect(F("16:9")).toEqual({ width: 1920, height: 1080, native: false })
    expect(F("9:16", 720)).toEqual({ width: 720, height: 1280, native: false })
    expect(F("4:3", 720)).toEqual({ width: 960, height: 720, native: false })
  })

  it("sizes native frames from the picture, the zoom and the width", () => {
    const pic = { width: 3840, height: 1608 }
    // The largest 9:16 box inside a 3840x1608 picture is 904x1608 (rounded down to even).
    expect(frameFor("9:16", pic)).toEqual({
      width: 904,
      height: 1608,
      native: true,
    })
    expect(frameFor("9:16", pic, undefined, 2)).toEqual({
      width: 452,
      height: 804,
      native: true,
    })
    // Zooming out keeps the frame; the picture shrinks inside it.
    expect(frameFor("9:16", pic, undefined, 0.5)).toEqual(frameFor("9:16", pic))
    expect(frameFor("16:9", pic)).toEqual({
      width: 2858,
      height: 1608,
      native: true,
    })
    // Squeezed to half width the picture is 1920x1608, which fits a 16:9 box 1920 wide.
    expect(frameFor("16:9", pic, undefined, 1, 0.5)).toEqual({
      width: 1920,
      height: 1080,
      native: true,
    })
  })
})

describe("placePicture", () => {
  const frame = F("9:16")

  it("covers the frame at zoom 1 and cuts the window at the focus", () => {
    const p = placePicture(frame, pic4k)
    expect(p).toMatchObject({
      width: 3414,
      height: 1920,
      cropW: 1080,
      cropH: 1920,
      cropY: 0,
      padX: 0,
      padY: 0,
      covers: true,
    })
    expect(p.cropX).toBe(1168)
    expect(placePicture(frame, pic4k, 1, 1, { x: 0, y: 0.5 }).cropX).toBe(0)
    expect(placePicture(frame, pic4k, 1, 1, { x: 1, y: 0.5 }).cropX).toBe(2334)
  })

  it("zooms in past the frame and out below it", () => {
    expect(placePicture(frame, pic4k, 2)).toMatchObject({
      width: 6826,
      height: 3840,
      cropW: 1080,
      cropH: 1920,
      covers: true,
    })
    const out = placePicture(frame, pic4k, 0.5)
    expect(out).toMatchObject({
      width: 1706,
      height: 960,
      cropW: 1080,
      cropH: 960,
      cropX: 314,
      cropY: 0,
      padX: 0,
      padY: 480,
      covers: false,
    })
    // Zoom is clamped to the API range.
    expect(placePicture(frame, pic4k, 0.01)).toEqual(
      placePicture(frame, pic4k, 0.25)
    )
    expect(placePicture(frame, pic4k, 99)).toEqual(
      placePicture(frame, pic4k, 4)
    )
  })

  it("squeezes the width before placing", () => {
    expect(placePicture(frame, pic4k, 1, 0.5)).toMatchObject({
      width: 1706,
      height: 1920,
      cropW: 1080,
      cropX: 314,
      covers: true,
    })
    // The squeeze is clamped to the API range.
    expect(placePicture(frame, pic4k, 1, 0.3)).toEqual(
      placePicture(frame, pic4k, 1, 0.5)
    )
    expect(placePicture(frame, pic4k, 1, 1.5)).toMatchObject({
      width: 5120,
      height: 1920,
    })
  })
})

describe("framePrescaleWidth", () => {
  it("downscales to the box the placement needs, never upscales", () => {
    const frame = F("9:16")
    const sdr4k = pic4k
    // 3413 rounded up to an even width for 4:2:0 output.
    expect(framePrescaleWidth(placePicture(frame, sdr4k), sdr4k)).toBe(3414)
    expect(
      framePrescaleWidth(placePicture(frame, sdr4k, 2), sdr4k)
    ).toBeUndefined()
    expect(framePrescaleWidth(placePicture(frame, sdr4k, 0.5), sdr4k)).toBe(
      1708
    )
    // A squeeze needs the un-squeezed width.
    expect(
      framePrescaleWidth(placePicture(frame, sdr4k, 1, 0.5), sdr4k, 0.5)
    ).toBe(3414)
    const hd = { width: 1920, height: 1080 }
    expect(framePrescaleWidth(placePicture(frame, hd), hd)).toBeUndefined()
    const native = frameFor("9:16", sdr4k)
    expect(
      framePrescaleWidth(placePicture(native, sdr4k), sdr4k)
    ).toBeUndefined()
  })
})

const at1080 = { shortSide: 1080 }

describe("frameFilters", () => {
  it("fixes colour first, tone-maps HDR before placing, then cuts 1080x1920", () => {
    const s = frameFilters(probe({ displayWidth: 3840, height: 2160 }), at1080)
    expect(s.startsWith("setparams=color_trc=bt709,")).toBe(true)
    expect(
      s.endsWith(
        ",format=yuv420p,scale=w=3414:h=1920:flags=lanczos,setsar=1,crop=w=1080:h=1920:x=1168:y=0"
      )
    ).toBe(true)
    expect(s).toContain("scale=w='min(3414,iw*sar)':h=-2:flags=lanczos")
    const h = frameFilters(hdr, at1080)
    expect(h.indexOf("tonemap=")).toBeLessThan(h.indexOf("crop=w=1080"))
  })

  it("fills the frame with black or a blurred copy when zoomed out", () => {
    const black = frameFilters(sdr(3840, 2160), {
      ...at1080,
      zoom: 0.5,
      background: "black",
    })
    expect(
      black.endsWith(
        "format=yuv420p,scale=w=1706:h=960:flags=lanczos,setsar=1,crop=w=1080:h=960:x=314:y=0,pad=w=1080:h=1920:x=0:y=480:color=black"
      )
    ).toBe(true)
    const blur = frameFilters(sdr(3840, 2160), { ...at1080, zoom: 0.5 })
    expect(
      blur.endsWith(
        "format=yuv420p,split[bg][fg];[bg]scale=w=270:h=480:force_original_aspect_ratio=increase:flags=bicubic,crop=w=270:h=480,gblur=sigma=8,scale=w=1080:h=1920:flags=bicubic[bgb];[fg]scale=w=1706:h=960:flags=lanczos,setsar=1,crop=w=1080:h=960:x=314:y=0[fgs];[bgb][fgs]overlay=x=0:y=480:format=yuv420,format=yuv420p"
      )
    ).toBe(true)
    // Covering the frame needs no background at all.
    expect(
      frameFilters(sdr(3840, 2160), { ...at1080, background: "blur" })
    ).not.toContain("split")
  })

  it("squeezes the width and honours the focus", () => {
    const s = frameFilters(sdr(3840, 2160), {
      ...at1080,
      widthScale: 0.5,
      focus: { x: 1, y: 0.5 },
    })
    expect(
      s.endsWith(
        "scale=w=1706:h=1920:flags=lanczos,setsar=1,crop=w=1080:h=1920:x=626:y=0"
      )
    ).toBe(true)
    expect(s).toContain("scale=w='min(3414,iw*sar)'")
  })

  it("cuts a native crop straight out of the picture", () => {
    const s = frameFilters(sdr(3840, 2160), {
      aspect: "9:16",
      focus: { x: 0.25, y: 0.5 },
      zoom: 2,
    })
    // Largest 9:16 box in 3840x2160 is 1215x2160; at zoom 2 the window is 606x1080.
    expect(s).toBe(
      "format=yuv420p,scale=w=3840:h=2160:flags=lanczos,setsar=1,crop=w=606:h=1080:x=808:y=540"
    )
    const out = frameFilters(sdr(3840, 2160), {
      aspect: "9:16",
      zoom: 0.5,
      background: "black",
    })
    // Zoomed out, the picture is downscaled before tone-mapping and padded to the native frame.
    expect(out).toBe(
      "scale=w='min(1920,iw*sar)':h=-2:flags=lanczos,setsar=1,format=yuv420p,scale=w=1920:h=1080:flags=lanczos,setsar=1,crop=w=1214:h=1080:x=354:y=0,pad=w=1214:h=2160:x=0:y=540:color=black"
    )
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

describe("frameFilters with bars", () => {
  const boxed = sdr(3840, 2160)
  const bars = { w: 3840, h: 1608, x: 0, y: 276 }

  it("crops the bars before placing and sizes the downscale to the picture", () => {
    const s = frameFilters(boxed, { ...at1080, bars, focus: { x: 1, y: 0.5 } })
    const cropAt = s.indexOf("crop=w=3840:h=1608:x=0:y=276")
    expect(cropAt).toBeGreaterThan(-1)
    expect(cropAt).toBeLessThan(s.indexOf("scale="))
    // 3840x1608 at 1920 tall is 4586 wide: bigger than the source, so no prescale.
    expect(s).not.toContain("scale=w='min(")
    expect(
      s.endsWith(
        "scale=w=4586:h=1920:flags=lanczos,setsar=1,crop=w=1080:h=1920:x=3506:y=0"
      )
    ).toBe(true)
    const native = frameFilters(boxed, { aspect: "1:1", bars })
    expect(native).toBe(
      "crop=w=3840:h=1608:x=0:y=276,format=yuv420p,scale=w=3840:h=1608:flags=lanczos,setsar=1,crop=w=1608:h=1608:x=1116:y=0"
    )
  })
})

describe("frameFilters with another aspect", () => {
  it("sizes the frame for every aspect", () => {
    const src = sdr(3840, 2160)
    expect(
      frameFilters(src, {
        ...at1080,
        aspect: "1:1",
        zoom: 0.5,
        background: "black",
      })
    ).toContain("pad=w=1080:h=1080:")
    expect(
      frameFilters(src, { ...at1080, aspect: "4:5", zoom: 0.5 })
    ).toContain("scale=w=1080:h=1350:flags=bicubic[bgb]")
    const wide = frameFilters(src, {
      ...at1080,
      aspect: "16:9",
      zoom: 2,
      focus: { x: 0.5, y: 0 },
    })
    expect(
      wide.endsWith(
        "scale=w=3840:h=2160:flags=lanczos,setsar=1,crop=w=1920:h=1080:x=960:y=0"
      )
    ).toBe(true)
    expect(wide).not.toContain("scale=w='min(")
    expect(frameFilters(src, { ...at1080, aspect: "16:9" })).toContain(
      "scale=w='min(1920,iw*sar)'"
    )
    expect(frameFilters(src, at1080)).toBe(
      frameFilters(src, { ...at1080, aspect: "9:16" })
    )
  })
})

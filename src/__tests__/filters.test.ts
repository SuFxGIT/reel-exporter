import { describe, expect, it } from "vitest"
import {
  colorFixup,
  fullResFilters,
  previewFilters,
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

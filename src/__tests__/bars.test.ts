import { describe, expect, it } from "vitest"
import {
  mergeCrops,
  parseCropLine,
  sampleTimes,
  worthTrimming,
} from "../media/bars.js"

describe("parseCropLine", () => {
  it("takes the last cropdetect line", () => {
    const err = [
      "[Parsed_cropdetect_0 @ 0x1] x1:0 x2:3839 y1:276 y2:1883 w:3840 h:1600 x:0 y:280 pts:1 t:0.04 crop=3840:1600:0:280",
      "[Parsed_cropdetect_0 @ 0x1] x1:0 x2:3839 y1:276 y2:1883 w:3840 h:1608 x:0 y:276 pts:2 t:0.08 crop=3840:1608:0:276",
    ].join("\n")
    expect(parseCropLine(err)).toEqual({ w: 3840, h: 1608, x: 0, y: 276 })
    expect(parseCropLine("nothing here")).toBeNull()
  })
})

describe("mergeCrops", () => {
  it("keeps every pixel any sample called picture", () => {
    expect(
      mergeCrops([
        { w: 3840, h: 1600, x: 0, y: 280 },
        { w: 3000, h: 1200, x: 400, y: 400 },
        { w: 3840, h: 1608, x: 0, y: 276 },
      ])
    ).toEqual({ w: 3840, h: 1608, x: 0, y: 276 })
    expect(mergeCrops([])).toBeNull()
  })
})

describe("worthTrimming", () => {
  it("only trims real bars", () => {
    expect(worthTrimming({ w: 3840, h: 1608, x: 0, y: 276 }, 3840, 2160)).toBe(
      true
    )
    expect(worthTrimming({ w: 3800, h: 2140, x: 20, y: 10 }, 3840, 2160)).toBe(
      false
    )
    // A dark scene that cropdetect shrank to a corner is not a letterbox.
    expect(worthTrimming({ w: 800, h: 600, x: 100, y: 100 }, 3840, 2160)).toBe(
      false
    )
    expect(worthTrimming({ w: 0, h: 0, x: 0, y: 0 }, 3840, 2160)).toBe(false)
  })
})

describe("sampleTimes", () => {
  it("spreads three half-second aligned samples across the range", () => {
    expect(sampleTimes(10, 20)).toEqual([10.5, 15, 18.5])
    expect(sampleTimes(10, 11)).toEqual([10])
    expect(sampleTimes(0, 4)).toEqual([0.5, 2, 2.5])
  })
})

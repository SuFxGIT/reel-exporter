import { describe, expect, it } from "vitest"
import { jpegQscale, screenshotEncoder } from "../media/encoders.js"

describe("jpegQscale", () => {
  it("maps quality to the mjpeg scale", () => {
    expect(jpegQscale(100)).toBe(1)
    expect(jpegQscale(90)).toBe(4)
    expect(jpegQscale(75)).toBe(9)
    expect(jpegQscale(50)).toBe(16)
  })

  it("clamps to 1..31", () => {
    expect(jpegQscale(150)).toBe(1)
    expect(jpegQscale(-100)).toBe(31)
  })
})

describe("screenshotEncoder", () => {
  it("keeps PNG lossless regardless of quality", () => {
    const e = screenshotEncoder("png", 60)
    expect(e).toEqual({
      ext: "png",
      pixelFormat: "rgb24",
      args: ["-c:v", "png", "-compression_level", "6"],
    })
  })

  it("passes the JPEG quality through the qscale mapping", () => {
    const e = screenshotEncoder("jpeg", 90)
    expect(e.ext).toBe("jpg")
    expect(e.pixelFormat).toBe("yuvj420p")
    expect(e.args).toEqual([
      "-c:v",
      "mjpeg",
      "-q:v",
      "4",
      "-huffman",
      "optimal",
    ])
  })

  it("writes lossy WebP from 4:2:0 and lossless WebP from RGB", () => {
    const lossy = screenshotEncoder("webp", 80)
    expect(lossy.pixelFormat).toBe("yuv420p")
    expect(lossy.args).toContain("-quality")
    expect(lossy.args[lossy.args.indexOf("-quality") + 1]).toBe("80")
    expect(lossy.args[lossy.args.indexOf("-lossless") + 1]).toBe("0")
    const lossless = screenshotEncoder("webp", 100)
    expect(lossless.pixelFormat).toBe("bgra")
    expect(lossless.args[lossless.args.indexOf("-lossless") + 1]).toBe("1")
    expect(lossless.args).not.toContain("-quality")
  })

  it("defaults to quality 90", () => {
    expect(screenshotEncoder("jpeg").args).toContain("4")
  })
})

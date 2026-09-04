export type ScreenshotFormat = "png" | "jpeg" | "webp"
export type ScreenshotPixelFormat = "rgb24" | "yuvj420p" | "yuv420p" | "bgra"

export interface ScreenshotEncoder {
  ext: "png" | "jpg" | "webp"
  pixelFormat: ScreenshotPixelFormat
  args: string[]
}

/** mjpeg qscale (1 best .. 31 worst) for a 50..100 quality: 100 -> 1, 90 -> 4, 75 -> 9, 50 -> 16. */
export const jpegQscale = (quality: number): number =>
  Math.min(31, Math.max(1, Math.round(1 + (100 - quality) * 0.3)))

/** Encoder arguments, output extension and the pixel format to feed it. */
export function screenshotEncoder(
  format: ScreenshotFormat,
  quality = 90
): ScreenshotEncoder {
  const q = Math.min(100, Math.max(50, Math.round(quality)))
  switch (format) {
    case "jpeg":
      return {
        ext: "jpg",
        pixelFormat: "yuvj420p",
        args: [
          "-c:v",
          "mjpeg",
          "-q:v",
          String(jpegQscale(q)),
          "-huffman",
          "optimal",
        ],
      }
    case "webp":
      // Lossless WebP must be fed RGB; 4:2:0 input would be subsampled first.
      return q >= 100
        ? {
            ext: "webp",
            pixelFormat: "bgra",
            args: [
              "-c:v",
              "libwebp",
              "-lossless",
              "1",
              "-compression_level",
              "6",
            ],
          }
        : {
            ext: "webp",
            pixelFormat: "yuv420p",
            args: [
              "-c:v",
              "libwebp",
              "-lossless",
              "0",
              "-quality",
              String(q),
              "-compression_level",
              "6",
            ],
          }
    default:
      return {
        ext: "png",
        pixelFormat: "rgb24",
        args: ["-c:v", "png", "-compression_level", "6"],
      }
  }
}

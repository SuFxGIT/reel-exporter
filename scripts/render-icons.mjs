#!/usr/bin/env node
// Rasterizes logo.svg into the PNGs the repo ships and copies it as the favicon.
// Usage: npm run icons   (sharp is a devDependency; no system packages needed)
import { copyFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const svg = readFileSync(resolve(root, "logo.svg"), "utf8")
// iOS applies its own mask, so the touch icon keeps square, opaque corners.
const squareCorners = svg.replace(/rx="\d+"/, 'rx="0"')

mkdirSync(resolve(root, "unraid"), { recursive: true })
mkdirSync(resolve(root, "web/public"), { recursive: true })
copyFileSync(resolve(root, "logo.svg"), resolve(root, "web/public/favicon.svg"))

const jobs = [
  ["unraid/icon.png", 512, svg],
  ["docs/logo-256.png", 256, svg],
  ["web/public/icon-192.png", 192, svg],
  ["web/public/apple-touch-icon.png", 180, squareCorners],
]
mkdirSync(resolve(root, "docs"), { recursive: true })
for (const [out, size, source] of jobs) {
  // density 288 renders the 512 unit viewBox at 2048 px before downsampling for crisp edges.
  await sharp(Buffer.from(source), { density: 288 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(resolve(root, out))
  console.log(`${out} ${size}x${size}`)
}

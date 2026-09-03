#!/usr/bin/env node
/**
 * Headless-browser smoke test: proves the app plays the transcoded stream in a real
 * Chrome and grabs a screenshot for the README. Talks to a browserless/chrome
 * container over its REST API, so it needs no npm dependencies.
 *
 *   docker run -d --rm --name rv-chrome -p 3939:3000 -e CONNECTION_TIMEOUT=180000 browserless/chrome:latest
 *   node scripts/smoke-browser.mjs --probe
 *   node scripts/smoke-browser.mjs --item <id> --out docs/screenshot.png
 *
 * Options: --app http://192.168.8.25:7727  --browserless http://127.0.0.1:3939
 *          --item <id>  --play 3  --seek 600  --out docs/screenshot.png  --probe
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const argv = process.argv.slice(2)
const get = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const opt = {
  app: get("--app", "http://192.168.8.25:7727"),
  browserless: get("--browserless", "http://127.0.0.1:3939"),
  item: get("--item"),
  play: Number(get("--play", "3")),
  seek: Number(get("--seek", "0")),
  out: get("--out", "docs/screenshot.png"),
  probe: argv.includes("--probe"),
}

// Runs inside browserless (puppeteer page). Serialized with toString(), so keep it self-contained.
const probe = async ({ page }) => {
  await page.goto("about:blank")
  const data = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    mseAvc1Aac: MediaSource.isTypeSupported(
      'video/mp4; codecs="avc1.640028,mp4a.40.2"'
    ),
    canPlayH264: document
      .createElement("video")
      .canPlayType('video/mp4; codecs="avc1.640028"'),
  }))
  return { data, type: "application/json" }
}

const smoke = async ({ page, context }) => {
  const { url, seconds, seek } = context
  const errors = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message || e}`))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`)
  })
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: "load", timeout: 30000 })
  await page.waitForSelector("video", { timeout: 20000 })
  await page.waitForFunction(
    () => document.querySelector("video").readyState >= 2,
    { timeout: 90000 }
  )
  if (seek > 0) {
    await page.evaluate((t) => {
      document.querySelector("video").currentTime = t
    }, seek)
    await page.waitForFunction(
      () =>
        !document.querySelector("video").seeking &&
        document.querySelector("video").readyState >= 2,
      { timeout: 90000 }
    )
  }
  const started = await page.evaluate(async () => {
    const v = document.querySelector("video")
    v.muted = true
    try {
      await v.play()
      return true
    } catch (e) {
      return `play() rejected: ${e.message}`
    }
  })
  await new Promise((r) => setTimeout(r, seconds * 1000))
  await page.evaluate(() => document.querySelector("video").pause())
  // Give the timeline a moment to draw, then move the pointer off the controls.
  await page.mouse.move(10, 10)
  await new Promise((r) => setTimeout(r, 800))
  const video = await page.evaluate(() => {
    const v = document.querySelector("video")
    return {
      currentTime: v.currentTime,
      readyState: v.readyState,
      paused: v.paused,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      error: v.error ? v.error.message : null,
    }
  })
  const waveCanvases = await page.evaluate(() => {
    const wave = document.querySelector(".rv-wave")
    const root =
      wave && wave.firstElementChild && wave.firstElementChild.shadowRoot
    return root ? root.querySelectorAll("canvas").length : 0
  })
  const screenshot = await page.screenshot({ type: "png", encoding: "base64" })
  return {
    data: { started, video, waveCanvases, errors, screenshot },
    type: "application/json",
  }
}

async function run(fn, context) {
  const res = await fetch(`${opt.browserless}/function`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: `module.exports = ${fn.toString()};`,
      context,
    }),
  })
  if (!res.ok) throw new Error(`browserless ${res.status}: ${await res.text()}`)
  return res.json()
}

if (opt.probe) {
  const r = await run(probe, {})
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.mseAvc1Aac ? 0 : 1)
}
if (!opt.item) {
  console.error("--item <id> is required (or --probe)")
  process.exit(2)
}
const { screenshot, ...report } = await run(smoke, {
  url: `${opt.app}/#/item/${opt.item}`,
  seconds: opt.play,
  seek: opt.seek,
})
mkdirSync(dirname(opt.out), { recursive: true })
writeFileSync(opt.out, Buffer.from(screenshot, "base64"))
console.log(JSON.stringify(report, null, 2))
const ok =
  report.started === true &&
  !report.video.error &&
  report.video.currentTime > (opt.seek || 0) + 1
console.log(
  ok
    ? `PASS: played to ${report.video.currentTime.toFixed(2)} s; screenshot -> ${opt.out}`
    : "FAIL"
)
process.exit(ok ? 0 : 1)

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CaptureOrderStore } from "../media/capture-order.js"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rv-order-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("CaptureOrderStore", () => {
  it("remembers, renames and forgets entries and survives a reload", async () => {
    const file = path.join(dir, "captures.json")
    const store = new CaptureOrderStore({ file, writable: true })
    expect(await store.load()).toBe("missing")
    await store.set("Movie (2020)", [
      "Movie (2020)/2.png",
      "Movie (2020)/1.png",
    ])
    await store.replace("Movie (2020)/2.png", "Movie (2020)/intro.png")
    expect(store.get("Movie (2020)")).toEqual([
      "Movie (2020)/intro.png",
      "Movie (2020)/1.png",
    ])
    await store.remove("Movie (2020)/1.png")
    expect(store.get("Movie (2020)")).toEqual(["Movie (2020)/intro.png"])

    const again = new CaptureOrderStore({ file, writable: true })
    expect(await again.load()).toBe("loaded")
    expect(again.get("Movie (2020)")).toEqual(["Movie (2020)/intro.png"])
    expect(again.get("Other")).toEqual([])
  })

  it("drops empty lists and duplicates", async () => {
    const file = path.join(dir, "captures.json")
    const store = new CaptureOrderStore({ file, writable: true })
    await store.set("A", ["A/1.png", "A/1.png", "A/2.mp4"])
    expect(store.get("A")).toEqual(["A/1.png", "A/2.mp4"])
    await store.remove("A/1.png")
    await store.remove("A/2.mp4")
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
      order: Record<string, string[]>
    }
    expect(raw.order).toEqual({})
  })

  it("keeps working in memory when the config dir is not writable", async () => {
    const file = path.join(dir, "captures.json")
    const store = new CaptureOrderStore({ file, writable: false })
    await store.set("A", ["A/1.png"])
    expect(store.get("A")).toEqual(["A/1.png"])
    expect(store.persistent).toBe(false)
    await expect(fs.access(file)).rejects.toThrow()
  })

  it("rebuilds from an invalid file", async () => {
    const file = path.join(dir, "captures.json")
    await fs.writeFile(file, "{not json")
    const store = new CaptureOrderStore({ file, writable: true })
    expect(await store.load()).toBe("invalid")
    expect(store.get("A")).toEqual([])
  })
})

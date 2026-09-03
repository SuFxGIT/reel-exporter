import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  SourcesError,
  SourcesStore,
  configHashOf,
  findSelectionConflict,
  normalizeRelPath,
  sourcesFileSchema,
  toEffective,
  type SourceConfig,
} from "../library/sources.js"

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rv-sources-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const mk = async (...segments: string[]) => {
  const p = path.join(root, ...segments)
  await fs.mkdir(p, { recursive: true })
  return p
}

describe("normalizeRelPath", () => {
  it.each([
    ["", "."],
    [".", "."],
    ["./", "."],
    ["./movies/", "movies"],
    ["a//b", "a/b"],
    ["movies 4k", "movies 4k"],
  ])("%j -> %j", (input, expected) =>
    expect(normalizeRelPath(input)).toBe(expected)
  )

  it.each(["../x", "/abs", "a\\b", ".hidden/x", "a/../b", "a/./b"])(
    "%j is invalid",
    (input) => expect(normalizeRelPath(input)).toBeNull()
  )
})

describe("findSelectionConflict", () => {
  it("detects nesting and duplicates", () => {
    expect(findSelectionConflict([".", "movies"])).toEqual({
      kind: "nested",
      outer: ".",
      inner: "movies",
    })
    expect(findSelectionConflict(["movies", "movies/4k"])).toEqual({
      kind: "nested",
      outer: "movies",
      inner: "movies/4k",
    })
    expect(findSelectionConflict(["movies/4k", "movies"])).toEqual({
      kind: "nested",
      outer: "movies",
      inner: "movies/4k",
    })
    expect(findSelectionConflict(["movies", "movies 4k"])).toBeNull()
    expect(findSelectionConflict(["tv", "tv"])).toEqual({
      kind: "duplicate",
      rel: "tv",
    })
  })
})

describe("toEffective / configHashOf", () => {
  const sources: SourceConfig[] = [
    {
      id: "a",
      path: "/media",
      libraries: [{ relPath: "movies" }, { relPath: "." }],
    },
    {
      id: "b",
      path: "/media2",
      libraries: [{ relPath: "movies" }, { relPath: "tv", name: "Films" }],
    },
    {
      id: "c",
      path: "/media3",
      libraries: [{ relPath: "docs", name: "Films" }],
    },
  ]

  it("derives and disambiguates names", () => {
    const eff = toEffective(sources)
    expect(eff[0]!.libraries.map((l) => l.name)).toEqual(["Movies", "Media"])
    expect(eff[1]!.libraries.map((l) => l.name)).toEqual([
      "Movies (media2)",
      "Films",
    ])
    expect(eff[2]!.libraries.map((l) => l.name)).toEqual(["Films (media3)"])
    const ids = eff.flatMap((s) => s.libraries.map((l) => l.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("hashes are order independent and ignore sources without libraries", () => {
    const h1 = configHashOf(sources)
    const reordered = [sources[2]!, sources[0]!, sources[1]!]
    expect(configHashOf(reordered)).toBe(h1)
    expect(
      configHashOf([...sources, { id: "d", path: "/media4", libraries: [] }])
    ).toBe(h1)
    const renamed = structuredClone(sources)
    renamed[1]!.libraries[1]!.name = "Series"
    expect(configHashOf(renamed)).not.toBe(h1)
  })
})

describe("SourcesStore", () => {
  it("validates added paths", async () => {
    const dir = await mk("store1")
    const src1 = await mk("store1", "src1")
    await mk("store1", "src1", "movies")
    const filePath = path.join(dir, "file.txt")
    await fs.writeFile(filePath, "x")
    const store = new SourcesStore({
      file: path.join(dir, "sources.json"),
      writable: true,
      reservedPaths: [path.join(dir, "reserved")],
    })
    expect(await store.load()).toBe("missing")

    await expect(store.addSource("relative/path")).rejects.toMatchObject({
      status: 400,
    })
    await expect(store.addSource("/")).rejects.toMatchObject({ status: 400 })
    await expect(
      store.addSource(path.join(dir, "missing"))
    ).rejects.toMatchObject({ status: 400, code: "not_found" })
    await expect(store.addSource(filePath)).rejects.toMatchObject({
      status: 400,
    })
    await expect(
      store.addSource(path.join(dir, "reserved", "x"))
    ).rejects.toMatchObject({ status: 400 })

    const added = await store.addSource(`${src1}/`)
    expect(added.path).toBe(src1)
    expect(added.libraries).toEqual([])
    await expect(store.addSource(src1)).rejects.toMatchObject({ status: 409 })
    await expect(
      store.addSource(path.join(src1, "movies"))
    ).rejects.toMatchObject({ status: 409 })
    await expect(store.addSource(dir)).rejects.toMatchObject({ status: 409 })

    const link = path.join(dir, "link")
    await fs.symlink(src1, link)
    await expect(store.addSource(link)).rejects.toBeInstanceOf(SourcesError)

    const onDisk = sourcesFileSchema.parse(
      JSON.parse(await fs.readFile(path.join(dir, "sources.json"), "utf8"))
    )
    expect(onDisk.sources.map((s) => s.path)).toEqual([src1])
  })

  it("sets libraries with validation and reloads them", async () => {
    const dir = await mk("store2")
    const src = await mk("store2", "src")
    await mk("store2", "src", "movies")
    await mk("store2", "src", "movies", "4k")
    await mk("store2", "src", "tv")
    const file = path.join(dir, "sources.json")
    const store = new SourcesStore({ file, writable: true, reservedPaths: [] })
    await store.load()
    const source = await store.addSource(src)

    await expect(store.setLibraries("nope", [])).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      store.setLibraries(source.id, [
        { relPath: "movies" },
        { relPath: "movies/4k" },
      ])
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      store.setLibraries(source.id, [{ relPath: "ghost" }])
    ).rejects.toMatchObject({ status: 400, code: "not_found" })
    await expect(
      store.setLibraries(source.id, [{ relPath: "../x" }])
    ).rejects.toMatchObject({ status: 400 })

    const updated = await store.setLibraries(source.id, [
      { relPath: "./movies/", name: "  Movies  " },
      { relPath: "tv", name: "Series" },
    ])
    // A name equal to the derived one is not stored as custom.
    expect(updated.libraries).toEqual([
      { relPath: "movies" },
      { relPath: "tv", name: "Series" },
    ])

    const eff = store.effective()
    expect(eff[0]!.libraries.map((l) => l.name)).toEqual(["Movies", "Series"])

    const again = new SourcesStore({ file, writable: true, reservedPaths: [] })
    expect(await again.load()).toBe("loaded")
    expect(again.list()[0]!.libraries).toEqual(updated.libraries)
    expect(again.configHash()).toBe(store.configHash())

    // An already selected folder that disappeared does not block other edits.
    await fs.rm(path.join(src, "tv"), { recursive: true })
    const kept = await store.setLibraries(source.id, [
      { relPath: "movies" },
      { relPath: "tv", name: "Series" },
    ])
    expect(kept.libraries.map((l) => l.relPath)).toEqual(["movies", "tv"])

    expect(await store.removeSource(source.id)).toBe(true)
    expect(await store.removeSource(source.id)).toBe(false)
    expect(store.list()).toEqual([])
  })

  it("seeds from MEDIA_PATH", async () => {
    const dir = await mk("store3")
    const media = await mk("store3", "media")
    await mk("store3", "media", "movies")
    await mk("store3", "media", "tv")
    await mk("store3", "media", "books")
    await mk("store3", "media", ".hidden")
    await fs.writeFile(path.join(media, "note.txt"), "")

    const all = new SourcesStore({
      file: path.join(dir, "all.json"),
      writable: true,
      reservedPaths: [],
    })
    const seeded = await all.seedFromMediaPath(media, {
      seedAll: true,
      skip: new Set(["books"]),
      mounted: false,
    })
    expect(seeded?.libraries.map((l) => l.relPath)).toEqual(["movies", "tv"])

    const none = new SourcesStore({
      file: path.join(dir, "none.json"),
      writable: false,
      reservedPaths: [],
    })
    const empty = await none.seedFromMediaPath(media, {
      seedAll: false,
      mounted: true,
    })
    expect(empty?.libraries).toEqual([])
    expect(none.persistent).toBe(false)
    await expect(fs.access(path.join(dir, "none.json"))).rejects.toBeTruthy()

    const missing = new SourcesStore({
      file: path.join(dir, "missing.json"),
      writable: true,
      reservedPaths: [],
    })
    expect(
      await missing.seedFromMediaPath(path.join(dir, "nope"), {
        seedAll: false,
        mounted: false,
      })
    ).toBeNull()

    const placeholder = await mk("store3", "empty-media")
    const ph = new SourcesStore({
      file: path.join(dir, "ph.json"),
      writable: true,
      reservedPaths: [],
    })
    expect(
      await ph.seedFromMediaPath(placeholder, {
        seedAll: false,
        mounted: false,
      })
    ).toBeNull()
    expect(
      (
        await ph.seedFromMediaPath(placeholder, {
          seedAll: false,
          mounted: true,
        })
      )?.path
    ).toBe(placeholder)
  })
})

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { hashId } from "../library/naming.js"
import { scanSources } from "../library/scanner.js"
import { toEffective, type SourceConfig } from "../library/sources.js"

let root: string
let src1: string
let src2: string

const touch = async (p: string) => {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, "")
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rv-scan-"))
  src1 = path.join(root, "src1")
  src2 = path.join(root, "src2")
  await touch(path.join(src1, "movies", "Foo (2001)", "Foo (2001).mkv"))
  await touch(
    path.join(
      src1,
      "tv",
      "Show (2020)",
      "Season 01",
      "Show - S01E01 - Pilot.mkv"
    )
  )
  await touch(
    path.join(
      src1,
      "tv",
      "Show (2020)",
      "Season 01",
      "Show - S01E02 - Second.mkv"
    )
  )
  await touch(path.join(src1, "other", "x.mkv"))
  await touch(path.join(src2, "movies", "Bar (1999)", "bar.mkv"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("scanSources", () => {
  it("scans only the selected folders of each source", async () => {
    const config: SourceConfig[] = [
      {
        id: "s1",
        path: src1,
        libraries: [
          { relPath: "movies" },
          { relPath: "tv" },
          { relPath: "missing" },
        ],
      },
      { id: "s2", path: src2, libraries: [{ relPath: "movies" }] },
    ]
    const spy = vi.spyOn(fs, "readdir")
    const result = await scanSources(toEffective(config), { configHash: "h" })
    const read = spy.mock.calls.map((c) => String(c[0]))
    spy.mockRestore()

    expect(read.some((p) => p.includes(`${path.sep}other`))).toBe(false)
    expect(read).not.toContain(src1)
    expect(read).not.toContain(src2)

    expect(result.version).toBe(2)
    expect(result.configHash).toBe("h")
    expect(result.sources.map((s) => s.path)).toEqual([src1, src2])

    const byName = Object.fromEntries(result.libraries.map((l) => [l.name, l]))
    expect(Object.keys(byName).sort()).toEqual([
      "Missing",
      "Movies",
      "Movies (src2)",
      "TV",
    ])
    expect(byName["Missing"]).toMatchObject({ available: false, items: [] })
    expect(byName["Movies"]!.id).not.toBe(byName["Movies (src2)"]!.id)

    const foo = byName["Movies"]!.items[0]!
    expect(foo).toMatchObject({
      kind: "movie",
      title: "Foo",
      year: 2001,
      sourceId: "s1",
      relPath: "movies/Foo (2001)/Foo (2001).mkv",
    })
    expect(foo.id).toBe(
      hashId(path.posix.join(src1, "movies/Foo (2001)/Foo (2001).mkv"))
    )
    const bar = byName["Movies (src2)"]!.items[0]!
    expect(bar).toMatchObject({
      kind: "movie",
      title: "Bar",
      sourceId: "s2",
      relPath: "movies/Bar (1999)/bar.mkv",
    })
    expect(bar.id).not.toBe(foo.id)

    const show = byName["TV"]!.items[0]!
    expect(show.kind).toBe("show")
    if (show.kind === "show") {
      expect(show.seasons[0]!.episodes.map((e) => e.relPath)).toEqual([
        "tv/Show (2020)/Season 01/Show - S01E01 - Pilot.mkv",
        "tv/Show (2020)/Season 01/Show - S01E02 - Second.mkv",
      ])
      expect(show.seasons[0]!.episodes[0]!.sourceId).toBe("s1")
    }
    expect(result.stats.files).toBe(4)
  })

  it("supports the source root as a library", async () => {
    const config: SourceConfig[] = [
      { id: "s2", path: src2, libraries: [{ relPath: "." }] },
    ]
    const eff = toEffective(config)
    const result = await scanSources(eff, { configHash: "h2" })
    expect(result.libraries).toHaveLength(1)
    const lib = result.libraries[0]!
    expect(lib.id).toBe(hashId(src2))
    expect(lib.name).toBe("Src2")
    expect(lib.relPath).toBe(".")
    // The root holds "movies/", which is classified as an item folder holding one movie.
    expect(lib.items.map((i) => i.relPath)).toEqual([
      "movies/Bar (1999)/bar.mkv",
    ])
  })
})

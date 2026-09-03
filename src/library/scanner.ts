import { promises as fs, type Dirent } from "node:fs"
import path from "node:path"
import pLimit from "p-limit"
import type { Logger } from "../logger.js"
import {
  cleanEpisodeTitle,
  cleanTitle,
  extOf,
  hashId,
  isIgnoredEntry,
  isVideoFile,
  naturalCompare,
  parseEpisode,
  parseSeasonDir,
  sortKey,
  stemOf,
} from "./naming.js"
import type { EffectiveLibrary, EffectiveSource } from "./sources.js"

export interface Movie {
  id: string
  kind: "movie"
  libraryId: string
  sourceId: string
  title: string
  year?: number
  sortTitle: string
  /** Relative to the source root, posix separators. */
  relPath: string
  ext: string
}

export interface Episode {
  id: string
  kind: "episode"
  libraryId: string
  sourceId: string
  showId: string
  season: number
  episode: number
  episodeEnd?: number
  title?: string
  relPath: string
  ext: string
  /** false when the number was assigned by sort order because the name had none. */
  numbered: boolean
}

export interface Season {
  number: number
  title?: string
  episodes: Episode[]
}

export interface Show {
  id: string
  kind: "show"
  libraryId: string
  sourceId: string
  title: string
  year?: number
  sortTitle: string
  relPath: string
  seasons: Season[]
  episodeCount: number
}

export type LibraryItem = Movie | Show
export type Playable = Movie | Episode

export interface Library {
  id: string
  sourceId: string
  /** Folder relative to the source root ("." for the root itself). */
  relPath: string
  name: string
  kind: "movies" | "shows" | "mixed"
  /** False when the folder was missing or unreadable during the last scan. */
  available: boolean
  items: LibraryItem[]
}

export interface ScanStats {
  files: number
  dirs: number
  warnings: number
  ms: number
}

export interface ScanResult {
  version: 2
  scannedAt: string
  /** Hash of the source configuration that produced this result. */
  configHash: string
  /** Snapshot of the sources that were scanned (paths resolve items to files). */
  sources: EffectiveSource[]
  libraries: Library[]
  stats: ScanStats
}

export interface ScanOptions {
  configHash: string
  log?: Logger
}

const MAX_ITEM_DEPTH = 3

interface Ctx {
  source: EffectiveSource
  log?: Logger
  stats: ScanStats
  limit: ReturnType<typeof pLimit>
}

const absOf = (ctx: Ctx, rel: string): string =>
  rel === "." ? ctx.source.path : path.join(ctx.source.path, rel)

const idOf = (ctx: Ctx, rel: string): string =>
  hashId(rel === "." ? ctx.source.path : path.posix.join(ctx.source.path, rel))

const joinRel = (base: string, name: string): string =>
  base === "." ? name : `${base}/${name}`

async function readdirSafe(ctx: Ctx, abs: string): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true })
    ctx.stats.dirs++
    return entries
  } catch (err) {
    ctx.stats.warnings++
    ctx.log?.warn(
      { dir: abs, err: (err as Error).message },
      "scan: cannot read directory"
    )
    return []
  }
}

const sortByName = <T extends { name: string }>(list: T[]): T[] =>
  [...list].sort((a, b) => naturalCompare(a.name, b.name))

/** Video files below `abs` (relative paths), at most `depth` levels down, naturally sorted. */
async function listVideos(
  ctx: Ctx,
  abs: string,
  depth: number
): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, rel: string, d: number): Promise<void> => {
    const entries = await readdirSafe(ctx, dir)
    for (const e of sortByName(entries)) {
      if (isIgnoredEntry(e.name)) continue
      if (e.isFile()) {
        if (isVideoFile(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name)
      } else if (e.isDirectory() && d < depth) {
        await walk(
          path.join(dir, e.name),
          rel ? `${rel}/${e.name}` : e.name,
          d + 1
        )
      }
    }
  }
  await walk(abs, "", 0)
  return out.sort(naturalCompare)
}

function movieFromFile(
  ctx: Ctx,
  libraryId: string,
  relPath: string,
  title: string,
  year?: number
): Movie {
  return {
    id: idOf(ctx, relPath),
    kind: "movie",
    libraryId,
    sourceId: ctx.source.id,
    title,
    ...(year ? { year } : {}),
    sortTitle: sortKey(title),
    relPath,
    ext: extOf(relPath),
  }
}

function buildMovies(
  ctx: Ctx,
  libraryId: string,
  relDir: string,
  videos: string[]
): Movie[] {
  const folder = cleanTitle(path.basename(relDir), { fromFile: false })
  if (videos.length === 1) {
    return [
      movieFromFile(
        ctx,
        libraryId,
        `${relDir}/${videos[0]}`,
        folder.title,
        folder.year
      ),
    ]
  }
  return videos.map((v) => {
    const file = cleanTitle(stemOf(v), { fromFile: true })
    return movieFromFile(
      ctx,
      libraryId,
      `${relDir}/${v}`,
      file.title || folder.title,
      file.year ?? folder.year
    )
  })
}

async function buildShow(
  ctx: Ctx,
  libraryId: string,
  relDir: string,
  videos: string[],
  seasonDirs: Dirent[],
  otherDirs: Dirent[]
): Promise<Show | null> {
  const absDir = absOf(ctx, relDir)
  const folder = cleanTitle(path.basename(relDir), { fromFile: false })
  const show: Show = {
    id: idOf(ctx, relDir),
    kind: "show",
    libraryId,
    sourceId: ctx.source.id,
    title: folder.title,
    ...(folder.year ? { year: folder.year } : {}),
    sortTitle: sortKey(folder.title),
    relPath: relDir,
    seasons: [],
    episodeCount: 0,
  }
  const seasons = new Map<number, Season>()
  const seen = new Set<string>()

  const add = (
    fileRel: string,
    season: number,
    episode: number,
    episodeEnd: number | undefined,
    title: string | undefined,
    numbered: boolean
  ) => {
    const key = `${season}:${episode}`
    if (seen.has(key)) {
      ctx.stats.warnings++
      ctx.log?.debug(
        { show: relDir, file: fileRel },
        "scan: duplicate episode number, keeping the first"
      )
      return
    }
    seen.add(key)
    let s = seasons.get(season)
    if (!s) {
      s = { number: season, episodes: [] }
      seasons.set(season, s)
    }
    s.episodes.push({
      id: idOf(ctx, fileRel),
      kind: "episode",
      libraryId,
      sourceId: ctx.source.id,
      showId: show.id,
      season,
      episode,
      ...(episodeEnd ? { episodeEnd } : {}),
      ...(title ? { title } : {}),
      relPath: fileRel,
      ext: extOf(fileRel),
      numbered,
    })
    ctx.stats.files++
  }

  // Files directly inside the show folder.
  for (const v of videos) {
    const p = parseEpisode(stemOf(v), { allowBare: true })
    if (!p) continue
    add(
      `${relDir}/${v}`,
      p.season ?? 1,
      p.episode,
      p.episodeEnd,
      cleanEpisodeTitle(p.rest),
      true
    )
  }

  for (const d of sortByName(seasonDirs)) {
    const sm = parseSeasonDir(d.name)!
    const files = await listVideos(ctx, path.join(absDir, d.name), 2)
    const unnumbered: string[] = []
    let maxEp = 0
    for (const f of files) {
      const p = parseEpisode(stemOf(path.basename(f)), { allowBare: true })
      if (!p) {
        unnumbered.push(f)
        continue
      }
      const season = p.season ?? sm.number
      if (season === sm.number)
        maxEp = Math.max(maxEp, p.episodeEnd ?? p.episode)
      add(
        `${relDir}/${d.name}/${f}`,
        season,
        p.episode,
        p.episodeEnd,
        cleanEpisodeTitle(p.rest),
        true
      )
    }
    for (const f of unnumbered) {
      maxEp += 1
      const title = cleanTitle(stemOf(path.basename(f)), {
        fromFile: true,
      }).title
      add(`${relDir}/${d.name}/${f}`, sm.number, maxEp, undefined, title, false)
    }
    if (sm.title) {
      const s = seasons.get(sm.number)
      if (s && !s.title) s.title = sm.title
    }
  }

  // Other sub-folders (Featurettes, screenshots...): only explicit SxxEyy names count.
  for (const d of sortByName(otherDirs)) {
    const files = await listVideos(ctx, path.join(absDir, d.name), 2)
    for (const f of files) {
      const p = parseEpisode(stemOf(path.basename(f)), { allowBare: false })
      if (!p?.explicit) continue
      add(
        `${relDir}/${d.name}/${f}`,
        p.season ?? 1,
        p.episode,
        p.episodeEnd,
        cleanEpisodeTitle(p.rest),
        true
      )
    }
  }

  show.seasons = [...seasons.values()]
    .sort((a, b) => a.number - b.number)
    .map((s) => ({
      ...s,
      episodes: s.episodes.sort((a, b) => a.episode - b.episode),
    }))
  show.episodeCount = show.seasons.reduce((n, s) => n + s.episodes.length, 0)
  return show.episodeCount > 0 ? show : null
}

async function classifyItemDir(
  ctx: Ctx,
  libraryId: string,
  relDir: string,
  depth: number
): Promise<LibraryItem[]> {
  const absDir = absOf(ctx, relDir)
  const entries = await readdirSafe(ctx, absDir)
  const videos = sortByName(
    entries.filter((e) => e.isFile() && isVideoFile(e.name))
  ).map((e) => e.name)
  const dirs = entries.filter((e) => e.isDirectory() && !isIgnoredEntry(e.name))
  const seasonDirs = dirs.filter((d) => parseSeasonDir(d.name) !== null)
  const otherDirs = dirs.filter((d) => parseSeasonDir(d.name) === null)

  const explicit = videos.filter(
    (v) => parseEpisode(stemOf(v), { allowBare: false })?.explicit
  ).length
  const epLike = videos.filter(
    (v) => parseEpisode(stemOf(v), { allowBare: true }) !== null
  ).length

  if (seasonDirs.length > 0 || explicit >= 1 || epLike >= 2) {
    const show = await buildShow(
      ctx,
      libraryId,
      relDir,
      videos,
      seasonDirs,
      otherDirs
    )
    return show ? [show] : []
  }
  if (videos.length > 0) {
    ctx.stats.files += videos.length
    return buildMovies(ctx, libraryId, relDir, videos)
  }
  if (otherDirs.length > 0 && depth < MAX_ITEM_DEPTH) {
    const nested = await Promise.all(
      sortByName(otherDirs).map((d) =>
        classifyItemDir(ctx, libraryId, `${relDir}/${d.name}`, depth + 1)
      )
    )
    return nested.flat()
  }
  return []
}

/** Scans one selected library folder. A missing or unreadable folder yields an empty, unavailable library. */
async function scanLibrary(ctx: Ctx, lib: EffectiveLibrary): Promise<Library> {
  const absDir = absOf(ctx, lib.relPath)
  const base = {
    id: lib.id,
    sourceId: ctx.source.id,
    relPath: lib.relPath,
    name: lib.name,
  }
  let entries: Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
    ctx.stats.dirs++
  } catch (err) {
    ctx.stats.warnings++
    ctx.log?.warn(
      { dir: absDir, err: (err as Error).message },
      "scan: library folder is missing or unreadable"
    )
    return { ...base, kind: "movies", available: false, items: [] }
  }
  const items: LibraryItem[] = []
  const tasks: Promise<LibraryItem[]>[] = []
  for (const e of sortByName(entries)) {
    if (isIgnoredEntry(e.name)) continue
    if (e.isFile()) {
      if (isVideoFile(e.name)) {
        const t = cleanTitle(stemOf(e.name), { fromFile: true })
        items.push(
          movieFromFile(
            ctx,
            lib.id,
            joinRel(lib.relPath, e.name),
            t.title,
            t.year
          )
        )
        ctx.stats.files++
      }
    } else if (e.isDirectory()) {
      tasks.push(
        ctx.limit(() =>
          classifyItemDir(ctx, lib.id, joinRel(lib.relPath, e.name), 1)
        )
      )
    }
  }
  for (const list of await Promise.all(tasks)) items.push(...list)
  items.sort(
    (a, b) =>
      naturalCompare(a.sortTitle, b.sortTitle) ||
      naturalCompare(a.relPath, b.relPath)
  )
  const shows = items.filter((i) => i.kind === "show").length
  const kind: Library["kind"] =
    shows === 0 ? "movies" : shows === items.length ? "shows" : "mixed"
  return { ...base, kind, available: true, items }
}

/**
 * Scans exactly the selected library folders of every source. The source roots
 * themselves are never listed, so unselected folders are never touched.
 */
export async function scanSources(
  sources: EffectiveSource[],
  opts: ScanOptions
): Promise<ScanResult> {
  const started = Date.now()
  const stats: ScanStats = { files: 0, dirs: 0, warnings: 0, ms: 0 }
  const limit = pLimit(8)
  const libraries: Library[] = []
  for (const source of sources) {
    const ctx: Ctx = { source, log: opts.log, stats, limit }
    for (const lib of source.libraries) {
      libraries.push(await scanLibrary(ctx, lib))
    }
  }
  libraries.sort(
    (a, b) =>
      naturalCompare(a.name, b.name) || naturalCompare(a.relPath, b.relPath)
  )
  stats.ms = Date.now() - started
  return {
    version: 2,
    scannedAt: new Date().toISOString(),
    configHash: opts.configHash,
    sources: structuredClone(sources),
    libraries,
    stats,
  }
}

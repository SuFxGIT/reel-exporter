import { promises as fs } from "node:fs"
import path from "node:path"
import type { Logger } from "../logger.js"
import { atomicWriteJson, readJson } from "../util/async.js"
import { episodeLabel, titleWithYear } from "./naming.js"
import {
  scanSources,
  type Episode,
  type Library,
  type LibraryItem,
  type Movie,
  type Playable,
  type ScanResult,
  type Show,
} from "./scanner.js"
import type { EffectiveSource } from "./sources.js"

export interface LibrarySummary {
  scannedAt: string | null
  scanning: boolean
  libraries: Array<{
    id: string
    name: string
    kind: Library["kind"]
    sourceId: string
    relPath: string
    available: boolean
    items: Array<{
      id: string
      type: "movie" | "show"
      title: string
      year?: number
      seasonCount?: number
      episodeCount?: number
    }>
  }>
}

export interface ShowDetail {
  id: string
  title: string
  year?: number
  seasons: Array<{
    number: number
    title?: string
    episodes: Array<{
      id: string
      season: number
      episode: number
      episodeEnd?: number
      label: string
      title?: string
    }>
  }>
}

/** Everything the media layer needs to know about a playable item. */
export interface PlayableInfo {
  item: Playable
  absPath: string
  show?: Show
  /** Display title: movie title or show title. */
  title: string
  year?: number
  /** "Title (Year)" used as the output folder name. */
  folderName: string
  /** "S01E02" for episodes. */
  episodeTag?: string
  episodeTitle?: string
  /** "Title (Year)[ - S01E02]" used as the base of capture file names. */
  baseName: string
}

export interface StoreOptions {
  /** Live source configuration, read at the start of every scan. */
  sources: () => EffectiveSource[]
  configHash: () => string
  cacheFile: string
  /** Probe/peaks cache root (a getter because it can be re-pointed at boot). */
  cacheDir: () => string
  log: Logger
}

export class LibraryStore {
  private data: ScanResult | null = null
  private index = new Map<string, LibraryItem | Episode>()
  private showOfEpisode = new Map<string, Show>()
  private sourcePaths = new Map<string, string>()
  private scanPromise: Promise<void> | null = null
  private rescanQueued = false
  private timer: NodeJS.Timeout | null = null
  lastError: string | null = null
  private readonly opts: StoreOptions

  constructor(opts: StoreOptions) {
    this.opts = opts
  }

  get scanning(): boolean {
    return this.scanPromise !== null
  }

  get scannedAt(): string | null {
    return this.data?.scannedAt ?? null
  }

  get result(): ScanResult | null {
    return this.data
  }

  async loadCache(): Promise<boolean> {
    const cached = await readJson<ScanResult>(this.opts.cacheFile)
    if (
      !cached ||
      cached.version !== 2 ||
      cached.configHash !== this.opts.configHash() ||
      !Array.isArray(cached.sources) ||
      !Array.isArray(cached.libraries)
    )
      return false
    this.apply(cached)
    this.opts.log.info(
      {
        scannedAt: cached.scannedAt,
        libraries: cached.libraries.length,
        items: this.index.size,
      },
      "library: loaded cached index"
    )
    return true
  }

  /**
   * Single-flight rescan. A request that arrives while a scan runs queues one more
   * scan so configuration changes made mid-scan are always picked up.
   */
  rescan(): Promise<void> {
    if (this.scanPromise) {
      this.rescanQueued = true
      return this.scanPromise
    }
    this.scanPromise = (async () => {
      const log = this.opts.log
      try {
        const sources = this.opts.sources()
        const configHash = this.opts.configHash()
        log.info(
          {
            sources: sources.map((s) => `${s.path}:${s.libraries.length}`),
          },
          "library: scan started"
        )
        const result = await scanSources(sources, { configHash, log })
        const allUnavailable =
          result.libraries.length > 0 &&
          result.libraries.every((l) => !l.available)
        if (allUnavailable && this.index.size > 0) {
          log.warn(
            "library: no source was reachable, keeping the previous index"
          )
          this.lastError = "No media source was reachable during the last scan."
          return
        }
        this.apply(result)
        this.lastError = null
        log.info(
          {
            libraries: result.libraries.map(
              (l) => `${l.name}:${l.available ? l.items.length : "missing"}`
            ),
            files: result.stats.files,
            dirs: result.stats.dirs,
            warnings: result.stats.warnings,
            ms: result.stats.ms,
          },
          "library: scan finished"
        )
        try {
          await atomicWriteJson(this.opts.cacheFile, result)
        } catch (err) {
          log.warn(
            { err: (err as Error).message, file: this.opts.cacheFile },
            "library: could not write cache"
          )
        }
        // Sweep only when every configured library was readable, and never while
        // nothing is configured yet (a fresh install would wipe every cache).
        if (
          result.libraries.length > 0 &&
          result.libraries.every((l) => l.available)
        )
          void this.sweepCaches()
      } catch (err) {
        this.lastError = (err as Error).message
        log.error({ err }, "library: scan failed")
      } finally {
        this.scanPromise = null
        if (this.rescanQueued) {
          this.rescanQueued = false
          void this.rescan()
        }
      }
    })()
    return this.scanPromise
  }

  startInterval(minutes: number): void {
    if (this.timer) clearInterval(this.timer)
    if (minutes <= 0) return
    this.timer = setInterval(() => void this.rescan(), minutes * 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private apply(result: ScanResult): void {
    const index = new Map<string, LibraryItem | Episode>()
    const showOfEpisode = new Map<string, Show>()
    for (const lib of result.libraries) {
      for (const item of lib.items) {
        index.set(item.id, item)
        if (item.kind === "show") {
          for (const s of item.seasons) {
            for (const ep of s.episodes) {
              index.set(ep.id, ep)
              showOfEpisode.set(ep.id, item)
            }
          }
        }
      }
    }
    this.data = result
    this.index = index
    this.showOfEpisode = showOfEpisode
    this.sourcePaths = new Map(result.sources.map((s) => [s.id, s.path]))
  }

  /** Deletes probe and peaks cache files for ids that no longer exist. */
  private async sweepCaches(): Promise<void> {
    const ids = this.playableIds()
    let removed = 0
    for (const [sub, re] of [
      ["probe", /^([a-f0-9]{12,20})\.json$/],
      ["peaks", /^([a-f0-9]{12,20})-a-?\d+\.json$/],
    ] as const) {
      const dir = path.join(this.opts.cacheDir(), sub)
      const names = await fs.readdir(dir).catch(() => [] as string[])
      for (const n of names) {
        const m = re.exec(n)
        if (!m || ids.has(m[1]!)) continue
        await fs.unlink(path.join(dir, n)).catch(() => undefined)
        removed++
      }
    }
    if (removed > 0)
      this.opts.log.info({ removed }, "library: swept stale caches")
  }

  summary(): LibrarySummary {
    return {
      scannedAt: this.scannedAt,
      scanning: this.scanning,
      libraries: (this.data?.libraries ?? []).map((lib) => ({
        id: lib.id,
        name: lib.name,
        kind: lib.kind,
        sourceId: lib.sourceId,
        relPath: lib.relPath,
        available: lib.available,
        items: lib.items.map((item) =>
          item.kind === "movie"
            ? {
                id: item.id,
                type: "movie" as const,
                title: item.title,
                ...(item.year ? { year: item.year } : {}),
              }
            : {
                id: item.id,
                type: "show" as const,
                title: item.title,
                ...(item.year ? { year: item.year } : {}),
                seasonCount: item.seasons.length,
                episodeCount: item.episodeCount,
              }
        ),
      })),
    }
  }

  counts(): { libraries: number; items: number; episodes: number } {
    let items = 0
    let episodes = 0
    for (const v of this.index.values()) {
      if (v.kind === "episode") episodes++
      else items++
    }
    return { libraries: this.data?.libraries.length ?? 0, items, episodes }
  }

  /** Item counts per library id from the last scan. */
  libraryCounts(): Map<string, { items: number; available: boolean }> {
    const m = new Map<string, { items: number; available: boolean }>()
    for (const lib of this.data?.libraries ?? [])
      m.set(lib.id, { items: lib.items.length, available: lib.available })
    return m
  }

  getShow(id: string): ShowDetail | null {
    const item = this.index.get(id)
    if (!item || item.kind !== "show") return null
    const pad = item.seasons.some((s) =>
      s.episodes.some((e) => e.episode >= 1000)
    )
      ? 4
      : 2
    return {
      id: item.id,
      title: item.title,
      ...(item.year ? { year: item.year } : {}),
      seasons: item.seasons.map((s) => ({
        number: s.number,
        ...(s.title ? { title: s.title } : {}),
        episodes: s.episodes.map((e) => ({
          id: e.id,
          season: e.season,
          episode: e.episode,
          ...(e.episodeEnd ? { episodeEnd: e.episodeEnd } : {}),
          label: episodeLabel(e.season, e.episode, e.episodeEnd, pad),
          ...(e.title ? { title: e.title } : {}),
        })),
      })),
    }
  }

  getPlayable(id: string): PlayableInfo | null {
    const item = this.index.get(id)
    if (!item || item.kind === "show") return null
    const root = this.sourcePaths.get(item.sourceId)
    if (!root) return null
    const absPath = path.join(root, item.relPath)
    if (item.kind === "movie") {
      const folderName = titleWithYear(item.title, item.year)
      return {
        item,
        absPath,
        title: item.title,
        ...(item.year ? { year: item.year } : {}),
        folderName,
        baseName: folderName,
      }
    }
    const show = this.showOfEpisode.get(id)!
    const pad = show.seasons.some((s) =>
      s.episodes.some((e) => e.episode >= 1000)
    )
      ? 4
      : 2
    const folderName = titleWithYear(show.title, show.year)
    const episodeTag = episodeLabel(
      item.season,
      item.episode,
      item.episodeEnd,
      pad
    )
    return {
      item,
      absPath,
      show,
      title: show.title,
      ...(show.year ? { year: show.year } : {}),
      folderName,
      episodeTag,
      ...(item.title ? { episodeTitle: item.title } : {}),
      baseName: `${folderName} - ${episodeTag}`,
    }
  }

  getItem(id: string): LibraryItem | Episode | null {
    return this.index.get(id) ?? null
  }

  /** All playable ids, used to sweep stale caches. */
  playableIds(): Set<string> {
    const ids = new Set<string>()
    for (const [id, v] of this.index) if (v.kind !== "show") ids.add(id)
    return ids
  }
}

export type { Episode, Library, LibraryItem, Movie, Playable, ScanResult, Show }

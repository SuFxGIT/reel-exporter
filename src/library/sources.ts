import { constants as fsConstants, promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Logger } from "../logger.js"
import { atomicWriteJson, withTimeout } from "../util/async.js"
import { resolveInside } from "../util/paths.js"
import {
  displayLibraryName,
  hashId,
  isIgnoredEntry,
  naturalCompare,
} from "./naming.js"

// ---------------------------------------------------------------------------
// Types and schema
// ---------------------------------------------------------------------------

export interface LibraryConfig {
  /** Folder relative to the source root, posix separators, "." for the root itself. */
  relPath: string
  /** Optional custom display name. */
  name?: string
}

export interface SourceConfig {
  id: string
  /** Absolute path inside the container. */
  path: string
  libraries: LibraryConfig[]
}

export interface SourcesFile {
  version: 1
  sources: SourceConfig[]
}

/** What the scanner and store consume: ids and disambiguated names already resolved. */
export interface EffectiveLibrary {
  id: string
  relPath: string
  name: string
}

export interface EffectiveSource {
  id: string
  path: string
  libraries: EffectiveLibrary[]
}

export const libraryConfigSchema = z.object({
  relPath: z.string().min(1).max(4096),
  name: z.string().trim().min(1).max(80).optional(),
})

export const sourceConfigSchema = z.object({
  id: z.string().optional(),
  path: z.string().min(1).max(4096),
  libraries: z.array(libraryConfigSchema).max(200).default([]),
})

export const sourcesFileSchema = z.object({
  version: z.literal(1),
  sources: z.array(sourceConfigSchema).max(32).default([]),
})

export const MAX_SOURCES = 32

export const DEFAULT_RESERVED_PATHS = [
  "/config",
  "/output",
  "/tmp",
  "/app",
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/run",
]

export const sourceId = (p: string): string => hashId(`source:${p}`)

export const libraryId = (sourcePath: string, relPath: string): string =>
  hashId(relPath === "." ? sourcePath : path.posix.join(sourcePath, relPath))

export class SourcesError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 503
  readonly code: string

  constructor(
    status: 400 | 403 | 404 | 409 | 503,
    code: string,
    message: string
  ) {
    super(message)
    this.status = status
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * "" | "." | "./" -> "."; strips "./" prefixes and trailing slashes; collapses "//".
 * null for NUL, backslashes, absolute paths, ".." segments or hidden/system entries.
 */
export function normalizeRelPath(raw: string): string | null {
  if (raw.includes("\0") || raw.includes("\\")) return null
  let s = raw.trim()
  if (s === "" || s === "." || s === "./") return "."
  if (s.startsWith("/")) return null
  s = s
    .replace(/^(\.\/)+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
  if (s === "" || s === ".") return "."
  const segments = s.split("/")
  if (
    segments.some(
      (seg) => seg === "" || seg === "." || seg === ".." || isIgnoredEntry(seg)
    )
  )
    return null
  return segments.join("/")
}

export const isAncestorRel = (outer: string, inner: string): boolean =>
  outer !== inner &&
  (outer === "." ? inner !== "." : inner.startsWith(`${outer}/`))

export type SelectionConflict =
  | { kind: "duplicate"; rel: string }
  | { kind: "nested"; outer: string; inner: string }

export function findSelectionConflict(
  rels: string[]
): SelectionConflict | null {
  for (let i = 0; i < rels.length; i++) {
    for (let j = i + 1; j < rels.length; j++) {
      const a = rels[i]!
      const b = rels[j]!
      if (a === b) return { kind: "duplicate", rel: a }
      if (isAncestorRel(a, b)) return { kind: "nested", outer: a, inner: b }
      if (isAncestorRel(b, a)) return { kind: "nested", outer: b, inner: a }
    }
  }
  return null
}

export function derivedLibraryName(
  sourcePath: string,
  relPath: string
): string {
  const base =
    relPath === "."
      ? path.posix.basename(sourcePath) || sourcePath
      : path.posix.basename(relPath)
  return displayLibraryName(base)
}

export function libraryDisplayName(
  source: Pick<SourceConfig, "path">,
  lib: LibraryConfig
): string {
  const custom = lib.name?.trim()
  return custom || derivedLibraryName(source.path, lib.relPath)
}

/** Resolves ids and names for every source; duplicate names get a disambiguating suffix. */
export function toEffective(sources: SourceConfig[]): EffectiveSource[] {
  const taken = new Set<string>()
  return sources.map((source) => ({
    id: source.id,
    path: source.path,
    libraries: source.libraries.map((lib) => {
      const base = libraryDisplayName(source, lib)
      const candidates = [
        base,
        `${base} (${path.posix.basename(source.path) || source.path})`,
        `${base} (${lib.relPath === "." ? source.path : path.posix.join(source.path, lib.relPath)})`,
      ]
      let name = candidates.find((c) => !taken.has(c.toLowerCase()))
      for (let n = 2; !name; n++) {
        const c = `${base} (${n})`
        if (!taken.has(c.toLowerCase())) name = c
      }
      taken.add(name.toLowerCase())
      return {
        id: libraryId(source.path, lib.relPath),
        relPath: lib.relPath,
        name,
      }
    }),
  }))
}

/** Hash of everything that affects the scan: sources with at least one library, their folders and names. */
export function configHashOf(sources: SourceConfig[]): string {
  const canonical = sources
    .filter((s) => s.libraries.length > 0)
    .map((s) => ({
      path: s.path,
      libraries: [...s.libraries]
        .sort((a, b) =>
          a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
        )
        .map((l) => ({ relPath: l.relPath, name: l.name ?? null })),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return hashId(JSON.stringify(canonical), 16)
}

function normalizeSourcePath(input: string): string | null {
  const s = input.trim()
  if (!s.startsWith("/") || s.includes("\0")) return null
  const norm = path.posix.normalize(s).replace(/\/+$/, "")
  return norm === "" ? "/" : norm
}

const isUnder = (p: string, base: string): boolean =>
  p === base || p.startsWith(`${base}/`)

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface SourcesStoreOptions {
  /** CONFIG_PATH/sources.json */
  file: string
  /** False keeps changes in memory only (config is not writable). */
  writable: boolean
  /** Paths the app uses itself; they and their children can never be sources. */
  reservedPaths?: string[]
  log?: Logger
}

export interface SourceStatus {
  id: string
  path: string
  exists: boolean
  readable: boolean
}

export class SourcesStore {
  private sources: SourceConfig[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private warnedUnwritable = false
  private readonly opts: SourcesStoreOptions
  private readonly reserved: string[]

  constructor(opts: SourcesStoreOptions) {
    this.opts = opts
    this.reserved = (opts.reservedPaths ?? DEFAULT_RESERVED_PATHS).map(
      (p) => normalizeSourcePath(p) ?? p
    )
  }

  get persistent(): boolean {
    return this.opts.writable
  }

  /** Paths that can never be a source (app, config, output, system roots). */
  get reservedPaths(): readonly string[] {
    return this.reserved
  }

  async load(): Promise<"loaded" | "missing" | "invalid"> {
    let text: string
    try {
      text = await fs.readFile(this.opts.file, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing"
      this.opts.log?.warn(
        { err: (err as Error).message, file: this.opts.file },
        "sources: cannot read sources.json"
      )
      return "invalid"
    }
    try {
      const parsed = sourcesFileSchema.parse(JSON.parse(text))
      const seen = new Set<string>()
      this.sources = []
      for (const s of parsed.sources) {
        const p = normalizeSourcePath(s.path)
        if (!p || p === "/" || seen.has(p)) continue
        seen.add(p)
        const libraries: LibraryConfig[] = []
        const rels = new Set<string>()
        for (const lib of s.libraries) {
          const rel = normalizeRelPath(lib.relPath)
          if (!rel || rels.has(rel)) continue
          rels.add(rel)
          libraries.push(
            lib.name ? { relPath: rel, name: lib.name } : { relPath: rel }
          )
        }
        this.sources.push({ id: sourceId(p), path: p, libraries })
      }
      return "loaded"
    } catch (err) {
      this.opts.log?.warn(
        { err: (err as Error).message, file: this.opts.file },
        "sources: sources.json is invalid, starting without sources"
      )
      this.sources = []
      return "invalid"
    }
  }

  /**
   * First-run migration from the legacy MEDIA_PATH mount. Returns the created source or
   * null when the folder is unusable (missing, unreadable, or the empty placeholder the
   * image ships when nothing is mounted there).
   */
  async seedFromMediaPath(
    mediaPath: string,
    opts: { seedAll: boolean; skip?: Set<string>; mounted: boolean }
  ): Promise<SourceConfig | null> {
    const p = normalizeSourcePath(mediaPath)
    if (!p || p === "/") return null
    let entries: import("node:fs").Dirent[]
    try {
      const st = await fs.stat(p)
      if (!st.isDirectory()) return null
      await fs.access(p, fsConstants.R_OK | fsConstants.X_OK)
      entries = await fs.readdir(p, { withFileTypes: true })
    } catch {
      this.opts.log?.warn(
        { path: p },
        "sources: MEDIA_PATH is not readable. Add a media source in the app once it is mounted"
      )
      return null
    }
    if (!opts.mounted && entries.length === 0) return null
    const libraries: LibraryConfig[] = []
    if (opts.seedAll) {
      const names = entries
        .filter(
          (e) =>
            e.isDirectory() &&
            !isIgnoredEntry(e.name) &&
            !opts.skip?.has(e.name.toLowerCase())
        )
        .map((e) => e.name)
        .sort(naturalCompare)
      for (const name of names) libraries.push({ relPath: name })
    }
    const source: SourceConfig = { id: sourceId(p), path: p, libraries }
    this.sources = [source]
    await this.save()
    this.opts.log?.info(
      { path: p, libraries: libraries.length },
      "sources: created sources.json from MEDIA_PATH"
    )
    return source
  }

  list(): SourceConfig[] {
    return structuredClone(this.sources)
  }

  get(id: string): SourceConfig | null {
    const s = this.sources.find((x) => x.id === id)
    return s ? structuredClone(s) : null
  }

  effective(): EffectiveSource[] {
    return toEffective(this.sources)
  }

  configHash(): string {
    return configHashOf(this.sources)
  }

  async status(): Promise<SourceStatus[]> {
    return Promise.all(
      this.sources.map(async (s) => {
        let exists = false
        let readable = false
        try {
          const st = await withTimeout(fs.stat(s.path), 5000)
          exists = st.isDirectory()
          if (exists) {
            await fs.access(s.path, fsConstants.R_OK | fsConstants.X_OK)
            readable = true
          }
        } catch {
          /* missing, unreadable or hung */
        }
        return { id: s.id, path: s.path, exists, readable }
      })
    )
  }

  addSource(input: string): Promise<SourceConfig> {
    return this.mutate(async () => {
      const p = normalizeSourcePath(input)
      if (!p)
        throw new SourcesError(
          400,
          "bad_request",
          "Enter an absolute container path such as /media2."
        )
      if (p === "/") {
        throw new SourcesError(
          400,
          "bad_request",
          "The container root cannot be a media source. Pick the folder where your library is mounted, such as /media."
        )
      }
      this.assertNotReserved(p)
      if (this.sources.length >= MAX_SOURCES)
        throw new SourcesError(
          400,
          "bad_request",
          `You can add up to ${MAX_SOURCES} sources.`
        )
      let st: import("node:fs").Stats
      try {
        st = await withTimeout(fs.stat(p), 5000)
      } catch (err) {
        if (
          (err as NodeJS.ErrnoException).code === "ENOENT" ||
          (err as NodeJS.ErrnoException).code === "ENOTDIR"
        ) {
          throw new SourcesError(
            400,
            "not_found",
            `${p} does not exist inside the container. Add it as a read-only path in the container settings (Unraid: Edit container, Add another Path, container path ${p}), then try again.`
          )
        }
        throw new SourcesError(
          503,
          "source_unavailable",
          `${p} did not respond. Check that the share is mounted and reachable, then try again.`
        )
      }
      if (!st.isDirectory())
        throw new SourcesError(
          400,
          "bad_request",
          `${p} is a file, not a folder.`
        )
      try {
        await fs.access(p, fsConstants.R_OK | fsConstants.X_OK)
      } catch {
        throw new SourcesError(
          400,
          "forbidden",
          `${p} exists but cannot be read by the app user (uid ${process.getuid?.() ?? "unknown"}). Fix the permissions on the host, then try again.`
        )
      }
      const real = await fs.realpath(p).catch(() => p)
      if (real !== p) this.assertNotReserved(real)
      for (const s of this.sources) {
        const sReal = await fs.realpath(s.path).catch(() => s.path)
        const same = p === s.path || real === sReal
        if (same) {
          throw new SourcesError(
            409,
            "conflict",
            p === s.path
              ? `${p} is already added.`
              : `${p} is the same folder as ${s.path}, which is already added.`
          )
        }
        if (isUnder(p, s.path) || isUnder(real, sReal)) {
          throw new SourcesError(
            409,
            "conflict",
            `${p} is inside the existing source ${s.path}. Open that source and select the folder there instead.`
          )
        }
        if (isUnder(s.path, p) || isUnder(sReal, real)) {
          throw new SourcesError(
            409,
            "conflict",
            `${p} contains the existing source ${s.path}. Remove ${s.path} first.`
          )
        }
      }
      const source: SourceConfig = { id: sourceId(p), path: p, libraries: [] }
      this.sources.push(source)
      await this.save()
      this.opts.log?.info({ path: p }, "sources: added")
      return structuredClone(source)
    })
  }

  removeSource(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const idx = this.sources.findIndex((s) => s.id === id)
      if (idx < 0) return false
      const [removed] = this.sources.splice(idx, 1)
      await this.save()
      this.opts.log?.info({ path: removed?.path }, "sources: removed")
      return true
    })
  }

  setLibraries(id: string, libraries: LibraryConfig[]): Promise<SourceConfig> {
    return this.mutate(async () => {
      const source = this.sources.find((s) => s.id === id)
      if (!source)
        throw new SourcesError(
          404,
          "not_found",
          "No source with that id. Reload the page and try again."
        )
      const next: LibraryConfig[] = []
      for (const lib of libraries) {
        const rel = normalizeRelPath(lib.relPath)
        if (!rel) {
          throw new SourcesError(
            400,
            "bad_request",
            `Folder path "${lib.relPath}" is not valid. Use a path relative to the source, such as "movies 4k".`
          )
        }
        const name = lib.name?.trim()
        const custom =
          name && name !== derivedLibraryName(source.path, rel)
            ? name
            : undefined
        next.push(custom ? { relPath: rel, name: custom } : { relPath: rel })
      }
      const conflict = findSelectionConflict(next.map((l) => l.relPath))
      if (conflict?.kind === "duplicate")
        throw new SourcesError(
          400,
          "bad_request",
          `"${conflict.rel}" is listed twice.`
        )
      if (conflict?.kind === "nested") {
        throw new SourcesError(
          400,
          "bad_request",
          `Folders cannot be nested: "${conflict.inner}" is inside "${conflict.outer}". Select one of them.`
        )
      }
      const existing = new Set(source.libraries.map((l) => l.relPath))
      for (const lib of next) {
        if (existing.has(lib.relPath)) continue
        const abs =
          lib.relPath === "."
            ? source.path
            : resolveInside(source.path, lib.relPath)
        let ok = false
        try {
          ok =
            abs !== null &&
            (await withTimeout(fs.stat(abs), 5000)).isDirectory()
        } catch {
          ok = false
        }
        if (!ok) {
          throw new SourcesError(
            400,
            "not_found",
            `No folder "${lib.relPath}" in ${source.path}. Refresh the folder list and pick it again.`
          )
        }
      }
      source.libraries = next
      await this.save()
      this.opts.log?.info(
        { path: source.path, libraries: next.map((l) => l.relPath) },
        "sources: libraries updated"
      )
      return structuredClone(source)
    })
  }

  private assertNotReserved(p: string): void {
    for (const r of this.reserved) {
      if (r && r !== "/" && isUnder(p, r)) {
        throw new SourcesError(
          400,
          "bad_request",
          `${p} is used by the app itself and cannot be a media source.`
        )
      }
    }
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async save(): Promise<void> {
    if (!this.opts.writable) {
      if (!this.warnedUnwritable) {
        this.warnedUnwritable = true
        this.opts.log?.warn(
          { file: this.opts.file },
          "sources: sources.json cannot be written; source changes are lost on restart"
        )
      }
      return
    }
    const data: SourcesFile = { version: 1, sources: this.sources }
    await atomicWriteJson(this.opts.file, data)
  }
}

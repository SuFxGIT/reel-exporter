import { createHash } from "node:crypto"

export const VIDEO_EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "ts",
  "m2ts",
  "mov",
  "webm",
  "mpg",
  "mpeg",
  "wmv",
  "ogm",
  "flv",
])

/** Containers whose timestamps or indexes ffmpeg handles better with +genpts and bigger probes. */
export const LEGACY_CONTAINERS = new Set([
  "avi",
  "ts",
  "m2ts",
  "mpg",
  "mpeg",
  "wmv",
  "ogm",
  "flv",
])

const SAMPLE_RE = /(^|[\s._-])(sample|proof|trailer)([\s._-]|$)/i

export function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

export function stemOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(0, i) : name
}

export function isVideoFile(name: string): boolean {
  if (!VIDEO_EXTENSIONS.has(extOf(name))) return false
  return !SAMPLE_RE.test(stemOf(name))
}

export function isIgnoredEntry(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("@")) return true
  const lower = name.toLowerCase()
  return (
    lower === "#recycle" ||
    lower === "lost+found" ||
    lower === "$recycle.bin" ||
    lower === "system volume information"
  )
}

/** Stable id for a library-relative path. NFC so NFD/NFC twins hash the same. */
export function hashId(relPath: string, length = 12): string {
  return createHash("sha1")
    .update(relPath.normalize("NFC"))
    .digest("hex")
    .slice(0, length)
}

export const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})
export const naturalCompare = (a: string, b: string): number =>
  naturalCollator.compare(a, b)

// ---------------------------------------------------------------------------
// Seasons and episodes
// ---------------------------------------------------------------------------

const SEASON_RE =
  /^(?:.*?\s-\s)?(?:season|saison|series|staffel|s)\s*0*(\d{1,3})(?:\s*[-:]\s*(.+?))?$/i
const SPECIALS_RE = /^(?:specials?|season\s*0+)$/i

export interface SeasonDirMatch {
  number: number
  title?: string
}

export function parseSeasonDir(name: string): SeasonDirMatch | null {
  const n = name.trim()
  if (SPECIALS_RE.test(n)) return { number: 0 }
  const m = SEASON_RE.exec(n)
  if (!m) return null
  const title = m[2]?.trim()
  return { number: Number(m[1]), ...(title ? { title } : {}) }
}

const SXXEYY_RE =
  /(?:^|[\s._\-\[(])S(\d{1,4})[\s._]?E(\d{1,4})(?:-?E?(\d{1,4}))?(?=[\s._\-\])]|$)/i
const NXNN_RE = /(?:^|[\s._-])(\d{1,2})x(\d{1,4})(?=[\s._-]|$)/i
const EP_RE = /(?:^|[\s._-])(?:ep|episode|e)\s*\.?\s*0*(\d{1,4})(?=[\s._-]|$)/i
const BARE_RE = /^0*(\d{1,4})(?:\s*[-.]\s*(.+))?$/

export interface EpisodeMatch {
  season?: number
  episode: number
  episodeEnd?: number
  /** Matched an explicit season+episode token (SxxEyy or NNxNN). */
  explicit: boolean
  /** Raw text after the token; run through cleanEpisodeTitle(). */
  rest: string
}

export function parseEpisode(
  stem: string,
  opts: { allowBare: boolean }
): EpisodeMatch | null {
  let m = SXXEYY_RE.exec(stem)
  if (m) {
    const episode = Number(m[2])
    const episodeEnd = m[3] ? Number(m[3]) : undefined
    return {
      season: Number(m[1]),
      episode,
      ...(episodeEnd !== undefined && episodeEnd > episode
        ? { episodeEnd }
        : {}),
      explicit: true,
      rest: stem.slice(m.index + m[0].length),
    }
  }
  m = NXNN_RE.exec(stem)
  if (m) {
    return {
      season: Number(m[1]),
      episode: Number(m[2]),
      explicit: true,
      rest: stem.slice(m.index + m[0].length),
    }
  }
  m = EP_RE.exec(stem)
  if (m) {
    return {
      episode: Number(m[1]),
      explicit: false,
      rest: stem.slice(m.index + m[0].length),
    }
  }
  if (opts.allowBare) {
    m = BARE_RE.exec(stem.trim())
    if (m) return { episode: Number(m[1]), explicit: false, rest: m[2] ?? "" }
  }
  return null
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const TAG_GROUP_RE = /\s*[\[{][^\]}]*[\]}]/g
const YEAR_RE = /(?:^|[\s(\[.])((?:19|20)\d{2})(?=[\s)\].]|$)/g
const QUALITY_TOKEN_RE =
  /(?:^|[\s.\-_])(s\d{1,2}e\d{1,4}|\d{1,2}x\d{2,4}|\d{3,4}p|2160p|4k|uhd|web-?dl|webrip|web|bluray|blu-ray|bdrip|brrip|hdtv|hdrip|dvdrip|dvd|remux|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|aac|ac3|eac3|dts|truehd|atmos|flac|hdr10\+?|hdr|dv|dovi|sdr|proper|repack|multi|amzn|nf|dsnp|hmax|atvp|internal|limited|extended|unrated|remastered)(?=[\s.\-_\]]|$)/i
const RELEASE_LIKE_RE =
  /\[[^\]]+\]|\{[^}]+\}|\b\d{3,4}p\b|\bx26[45]\b|\b(?:web-?dl|webrip|bluray|hdtv|remux|bdrip)\b/i

export interface TitleParse {
  title: string
  year?: number
}

function trimSeparators(s: string): string {
  return s
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s._-]+/, "")
    .replace(/(\s+[-–])+\s*$/, "")
    .replace(/[\s.]+$/, "")
    .trim()
}

/** Cleans a folder name or a file stem into a display title and optional year. */
export function cleanTitle(
  raw: string,
  opts: { fromFile: boolean }
): TitleParse {
  let year: number | undefined
  let head = raw
  let last: { index: number; year: string } | null = null
  for (const m of raw.matchAll(YEAR_RE)) {
    const idx = m.index + m[0].indexOf(m[1]!)
    if (idx === 0) continue // a bare leading year is the title (1917, 2012)
    last = { index: idx, year: m[1]! }
  }
  if (last) {
    const before = raw.slice(0, last.index).replace(/[(\[]\s*$/, "")
    if (trimSeparators(before.replace(TAG_GROUP_RE, " ")).length > 0) {
      year = Number(last.year)
      head = before
    }
  }
  let title = head.replace(TAG_GROUP_RE, " ")
  const dotted = !/\s/.test(raw.trim()) && /[._]/.test(raw)
  const releaseLike = opts.fromFile && (RELEASE_LIKE_RE.test(raw) || dotted)
  if (releaseLike) {
    if (!/\s/.test(title.trim())) title = title.replace(/[._]+/g, " ")
    const q = QUALITY_TOKEN_RE.exec(title)
    if (q && q.index > 0) title = title.slice(0, q.index)
    title = title.replace(/-[A-Za-z0-9]{2,}$/, "")
  }
  title = trimSeparators(title)
  if (!title) title = trimSeparators(raw.replace(TAG_GROUP_RE, " ")) || raw
  return year !== undefined ? { title, year } : { title }
}

/** Cleans the remainder after an episode token ("- Welcome to Margrave [WEBDL-1080p]..."). */
export function cleanEpisodeTitle(rest: string): string | undefined {
  let s = rest.replace(TAG_GROUP_RE, " ")
  s = s.replace(/^[\s._-]+/, "")
  if (!/\s/.test(s.trim()) && /[._]/.test(s)) s = s.replace(/[._]+/g, " ")
  const q = QUALITY_TOKEN_RE.exec(s)
  if (q) s = s.slice(0, q.index)
  s = s.replace(/-[A-Za-z0-9]{2,}$/, "")
  s = trimSeparators(s)
  return s.length > 0 ? s : undefined
}

const UPPER_TOKENS = new Set([
  "tv",
  "4k",
  "uhd",
  "hd",
  "3d",
  "hdr",
  "dv",
  "uk",
  "us",
])

export function displayLibraryName(dirName: string): string {
  return dirName
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) =>
      UPPER_TOKENS.has(w.toLowerCase())
        ? w.toUpperCase()
        : w[0]!.toUpperCase() + w.slice(1)
    )
    .join(" ")
}

export function sortKey(title: string): string {
  let t = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
  t = t.replace(/^(the|a|an|le|la|les|el|ال)\s+/u, "")
  return t.replace(/\d+/g, (d) => d.padStart(6, "0"))
}

// ---------------------------------------------------------------------------
// Output naming
// ---------------------------------------------------------------------------

/** Filesystem-safe name that keeps Unicode. Capped by bytes (ext4/xfs allow 255). */
export function safeName(input: string, maxBytes = 200): string {
  let s = input
    .normalize("NFC")
    .replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
  if (!s) s = "untitled"
  const chars = Array.from(s)
  while (Buffer.byteLength(chars.join("")) > maxBytes) chars.pop()
  return chars.join("").replace(/[.\s]+$/g, "") || "untitled"
}

export function titleWithYear(title: string, year?: number): string {
  return year ? `${title} (${year})` : title
}

export function episodeLabel(
  season: number,
  episode: number,
  episodeEnd?: number,
  pad = 2
): string {
  const s = String(season).padStart(2, "0")
  const e = String(episode).padStart(pad, "0")
  if (episodeEnd && episodeEnd > episode)
    return `S${s}E${e}-E${String(episodeEnd).padStart(pad, "0")}`
  return `S${s}E${e}`
}

/** 754.567 -> "00-12-34.567" */
export function formatTimestampForName(seconds: number): string {
  const t = Math.max(0, seconds)
  const whole = Math.floor(t)
  let ms = Math.round((t - whole) * 1000)
  let total = whole
  if (ms === 1000) {
    ms = 0
    total += 1
  }
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${pad(h)}-${pad(m)}-${pad(s)}.${pad(ms, 3)}`
}

/** Next free number for "1.png", "2.jpg", ... given the names already in the folder. */
export function nextCaptureNumber(names: Iterable<string>): number {
  let max = 0
  for (const n of names) {
    const m = /^(\d{1,9})\.(?:png|jpe?g)$/i.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

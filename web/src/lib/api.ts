export interface LibraryItemSummary {
  id: string
  type: "movie" | "show"
  title: string
  year?: number
  seasonCount?: number
  episodeCount?: number
}

export interface LibrarySummary {
  scannedAt: string | null
  scanning: boolean
  libraries: Array<{
    id: string
    name: string
    kind: "movies" | "shows" | "mixed"
    sourceId: string
    relPath: string
    available: boolean
    items: LibraryItemSummary[]
  }>
}

export interface SourceLibrary {
  id: string
  relPath: string
  name: string
  customName: string | null
  itemCount: number
  available: boolean
}

export interface Source {
  id: string
  path: string
  hostPath?: string
  readOnly: boolean
  exists: boolean
  readable: boolean
  libraries: SourceLibrary[]
}

export interface SourceCandidate {
  path: string
  hostPath?: string
  readOnly: boolean
}

export interface SourcesResponse {
  persistent: boolean
  scanning: boolean
  sources: Source[]
  candidates: SourceCandidate[]
}

export interface BrowseFolder {
  name: string
  relPath: string
  videoCount?: number
  selected: boolean
  blockedBy?: string
}

export interface BrowseResponse {
  path: string
  parentPath: string | null
  selected: boolean
  blockedBy?: string
  videoCount: number
  truncated: boolean
  folders: BrowseFolder[]
}

export interface LibrarySelection {
  relPath: string
  name?: string
}

export interface EpisodeSummary {
  id: string
  season: number
  episode: number
  episodeEnd?: number
  label: string
  title?: string
}

export interface ShowDetail {
  id: string
  title: string
  year?: number
  seasons: Array<{ number: number; title?: string; episodes: EpisodeSummary[] }>
}

export interface AudioStream {
  index: number
  codec: string
  profile?: string
  channels: number
  channelLayout?: string
  language?: string
  title?: string
  default: boolean
  commentary: boolean
}

export interface HdrInfo {
  kind: "sdr" | "pq" | "hlg" | "dovi-p5" | "unknown-hdr"
  tonemap: boolean
  dovi?: { profile: number }
  peakNits?: number
}

export interface ItemDetail {
  id: string
  type: "movie" | "episode"
  title: string
  year?: number
  showId?: string
  season?: number
  episode?: number
  episodeLabel?: string
  episodeTitle?: string
  file: { relPath: string; name: string; ext: string; size: number }
  duration: number
  container: string
  hasVideo: boolean
  video?: {
    codec: string
    width: number
    height: number
    displayWidth: number
    bitDepth: number
    interlaced: boolean
    fps?: number
  }
  fps?: number
  hdr: HdrInfo
  audio: AudioStream[]
  defaultAudio: number
}

export interface PeaksData {
  duration: number
  peaksPerSecond: number
  count: number
  maxPeak: number
  peaks: string
}

export type PeaksResponse =
  { pending: true } | { pending: false; data: PeaksData }

export interface Capture {
  name: string
  relPath: string
  kind: "screenshot" | "clip" | "gif"
  size: number
  mtime: string
  url: string
  thumbUrl: string
  downloadUrl: string
}

export interface Job {
  id: string
  type: "clip" | "gif"
  itemId: string
  status: "queued" | "running" | "done" | "failed" | "cancelled"
  progress: number
  createdAt: string
  params: {
    format: "mp4" | "gif"
    start: number
    end: number
    audio: number
    quality: "high" | "balanced" | "small"
    maxWidth?: number
    aspect?: "source" | "9:16" | "4:5" | "1:1" | "4:3" | "16:9"
    shortSide?: number
    fit?: "blur" | "crop" | "bars" | "stretch"
    fps?: number
    width?: number
  }
  output?: {
    relPath: string
    name: string
    size: number
    url: string
    thumbUrl: string
    downloadUrl: string
  }
  error?: string
}

export interface BarsResponse {
  /** Picture rectangle without black bars, in stored source pixels; null when there are none. */
  crop: { w: number; h: number; x: number; y: number } | null
  width: number
  height: number
  sar: number
}

export interface CapturesResponse {
  captures: Capture[]
  jobs: Job[]
}

export interface ScreenshotResponse {
  file: string
  name: string
  format: "png" | "jpeg" | "webp"
  width: number
  height: number
  size: number
  t: number
  url: string
  thumbUrl: string
  downloadUrl: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const msg =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      `Request failed (${res.status})`
    throw new ApiError(res.status, msg)
  }
  return body as T
}

export const api = {
  library: () => request<LibrarySummary>("/api/library"),
  rescan: () =>
    request<{ scanning: boolean }>("/api/library/rescan", { method: "POST" }),
  show: (id: string) => request<ShowDetail>(`/api/shows/${id}`),
  item: (id: string) => request<ItemDetail>(`/api/items/${id}`),
  peaks: async (id: string, audio: number): Promise<PeaksResponse> => {
    const res = await fetch(`/api/items/${id}/peaks?audio=${audio}`, {
      headers: { accept: "application/json" },
    })
    if (res.status === 202) return { pending: true }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      throw new ApiError(
        res.status,
        body?.error?.message ?? `Waveform request failed (${res.status})`
      )
    }
    return { pending: false, data: (await res.json()) as PeaksData }
  },
  screenshot: (
    id: string,
    t: number,
    opts: {
      format: "png" | "jpeg" | "webp"
      maxWidth?: number
      quality?: number
    }
  ) =>
    request<ScreenshotResponse>(`/api/items/${id}/screenshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t, ...opts }),
    }),
  clip: (
    id: string,
    start: number,
    end: number,
    audio: number,
    opts: {
      format: "mp4" | "gif"
      quality?: "high" | "balanced" | "small"
      aspect?: "source" | "9:16" | "4:5" | "1:1" | "4:3" | "16:9"
      maxWidth?: number
      shortSide?: number
      fit?: "blur" | "crop" | "bars" | "stretch"
      focus?: { x: number; y: number }
      zoom?: number
      fps?: number
      width?: number
    }
  ) =>
    request<{ jobId: string; job: Job }>(`/api/items/${id}/clip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start, end, audio, ...opts }),
    }),
  bars: (id: string, start: number, end: number) =>
    request<BarsResponse>(
      `/api/items/${id}/bars?start=${start.toFixed(1)}&end=${end.toFixed(1)}`
    ),
  captures: (id: string) =>
    request<CapturesResponse>(`/api/items/${id}/captures`),
  deleteCapture: (capture: { url: string }) =>
    request<void>(capture.url, { method: "DELETE" }),
  renameCapture: (id: string, capture: { relPath: string }, name: string) =>
    request<Capture>(`/api/items/${id}/captures/rename`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relPath: capture.relPath, name }),
    }),
  reorderCaptures: (id: string, relPaths: string[]) =>
    request<void>(`/api/items/${id}/captures/order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relPaths }),
    }),
  sources: () => request<SourcesResponse>("/api/sources"),
  addSource: async (p: string) => {
    const r = await request<{ source: Source }>("/api/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: p }),
    })
    return r.source
  },
  removeSource: (id: string) =>
    request<void>(`/api/sources/${id}`, { method: "DELETE" }),
  browse: (id: string, relPath: string) =>
    request<BrowseResponse>(
      `/api/sources/${id}/browse?path=${encodeURIComponent(relPath)}`
    ),
  setLibraries: async (id: string, libraries: LibrarySelection[]) => {
    const r = await request<{ source: Source }>(
      `/api/sources/${id}/libraries`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ libraries }),
      }
    )
    return r.source
  },
  job: (jobId: string) => request<Job>(`/api/jobs/${jobId}`),
  cancelJob: (jobId: string) =>
    request<void>(`/api/jobs/${jobId}`, { method: "DELETE" }),
  releaseHls: (id: string, audio: number) =>
    request<void>(`/api/items/${id}/hls/a${audio}`, { method: "DELETE" }),
}

export const hlsUrl = (id: string, audio: number): string =>
  `/api/items/${id}/hls/a${audio}/index.m3u8`
export const frameUrl = (id: string, t: number, width = 320): string =>
  `/api/items/${id}/frame?t=${(Math.round(t * 2) / 2).toFixed(1)}&w=${width}`

/** Human label per export type, for toasts and the captures strip. */
export const exportLabel: Record<Job["type"], string> = {
  clip: "Video",
  gif: "GIF",
}

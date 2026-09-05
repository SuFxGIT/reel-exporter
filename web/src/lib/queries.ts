import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query"
import { api, type ItemDetail, type PeaksData } from "./api"

export function useLibrary() {
  return useQuery({
    queryKey: ["library"],
    queryFn: api.library,
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data?.scanning ? 3000 : false),
  })
}

export function useShows(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["show", id],
      queryFn: () => api.show(id),
      staleTime: Infinity,
    })),
  })
}

export function useItem(id: string | null) {
  return useQuery({
    queryKey: ["item", id],
    queryFn: () => api.item(id!),
    enabled: id !== null,
    staleTime: Infinity,
    retry: false,
  })
}

/** Decoded peaks normalised to 0..1, or null while pending. */
export function decodePeaks(data: PeaksData): Float32Array {
  const bin = atob(data.peaks)
  const out = new Float32Array(bin.length)
  const max = data.maxPeak > 0 ? data.maxPeak : 255
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) / max
  return out
}

export function usePeaks(item: ItemDetail | undefined, audio: number) {
  return useQuery({
    queryKey: ["peaks", item?.id, audio],
    queryFn: () => api.peaks(item!.id, audio),
    enabled: Boolean(item && item.audio.length > 0),
    staleTime: Infinity,
    retry: 1,
    refetchInterval: (q) => (q.state.data?.pending ? 1500 : false),
  })
}

export function useCaptures(id: string | null) {
  return useQuery({
    queryKey: ["captures", id],
    queryFn: () => api.captures(id!),
    enabled: id !== null,
    staleTime: 10_000,
  })
}

export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: jobId !== null,
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === "done" || s === "failed" || s === "cancelled" ? false : 500
    },
  })
}

export function useSources(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["sources"],
    queryFn: api.sources,
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
  })
}

export function useBrowse(sourceId: string | null, relPath: string) {
  return useQuery({
    queryKey: ["browse", sourceId, relPath],
    queryFn: () => api.browse(sourceId!, relPath),
    enabled: sourceId !== null,
    staleTime: 60_000,
    retry: false,
    // Keep the previous listing only while staying inside the same source.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === sourceId ? prev : undefined,
  })
}

/** Black bars baked into the picture for a range; drives the Shorts crop preview. */
export function useBars(
  id: string,
  start: number,
  end: number,
  enabled: boolean
) {
  const s = Math.round(start * 2) / 2
  const e = Math.max(s, Math.round(end * 2) / 2)
  return useQuery({
    queryKey: ["bars", id, s, e],
    queryFn: () => api.bars(id, s, e),
    enabled,
    staleTime: 300_000,
    retry: 1,
  })
}

export function useInvalidate() {
  const qc = useQueryClient()
  return {
    captures: (id: string) =>
      qc.invalidateQueries({ queryKey: ["captures", id] }),
    library: () => qc.invalidateQueries({ queryKey: ["library"] }),
    sources: () => qc.invalidateQueries({ queryKey: ["sources"] }),
  }
}

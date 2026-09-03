import { useMemo } from "react"
import type {
  EpisodeSummary,
  LibraryItemSummary,
  LibrarySummary,
  ShowDetail,
} from "@/lib/api"
import { matchesQuery, normalizeForSearch } from "@/lib/text"

export type Row =
  | {
      type: "library"
      key: string
      libraryId: string
      name: string
      count: number
      collapsed: boolean
    }
  | { type: "movie"; key: string; item: LibraryItemSummary; libraryId: string }
  | {
      type: "show"
      key: string
      item: LibraryItemSummary
      libraryId: string
      expanded: boolean
      loading: boolean
    }
  | {
      type: "season"
      key: string
      showId: string
      number: number
      title?: string
      count: number
      expanded: boolean
    }
  | { type: "episode"; key: string; showId: string; episode: EpisodeSummary }
  | { type: "empty"; key: string; text: string }

export interface RowState {
  query: string
  collapsedLibraries: Set<string>
  expandedShows: Set<string>
  collapsedSeasons: Set<string>
  showDetails: Map<string, ShowDetail | undefined>
}

export function useLibraryRows(
  library: LibrarySummary | undefined,
  state: RowState
): Row[] {
  return useMemo(() => {
    if (!library) return []
    const q = normalizeForSearch(state.query)
    const rows: Row[] = []
    for (const lib of library.libraries) {
      const items = q
        ? lib.items.filter((i) => matchesQuery(i.title, q))
        : lib.items
      if (q && items.length === 0) continue
      const collapsed = !q && state.collapsedLibraries.has(lib.id)
      rows.push({
        type: "library",
        key: `lib:${lib.id}`,
        libraryId: lib.id,
        name: lib.name,
        count: items.length,
        collapsed,
      })
      if (collapsed) continue
      for (const item of items) {
        if (item.type === "movie") {
          rows.push({
            type: "movie",
            key: `movie:${item.id}`,
            item,
            libraryId: lib.id,
          })
          continue
        }
        const expanded = state.expandedShows.has(item.id)
        const detail = expanded ? state.showDetails.get(item.id) : undefined
        rows.push({
          type: "show",
          key: `show:${item.id}`,
          item,
          libraryId: lib.id,
          expanded,
          loading: expanded && !detail,
        })
        if (!expanded || !detail) continue
        for (const season of detail.seasons) {
          const seasonKey = `${item.id}:${season.number}`
          const seasonExpanded = !state.collapsedSeasons.has(seasonKey)
          rows.push({
            type: "season",
            key: `season:${seasonKey}`,
            showId: item.id,
            number: season.number,
            ...(season.title ? { title: season.title } : {}),
            count: season.episodes.length,
            expanded: seasonExpanded,
          })
          if (!seasonExpanded) continue
          for (const ep of season.episodes)
            rows.push({
              type: "episode",
              key: `ep:${ep.id}`,
              showId: item.id,
              episode: ep,
            })
        }
      }
    }
    if (rows.length === 0)
      rows.push({
        type: "empty",
        key: "empty",
        text: q
          ? "Nothing matches that search."
          : "No videos found in the library.",
      })
    return rows
  }, [
    library,
    state.query,
    state.collapsedLibraries,
    state.expandedShows,
    state.collapsedSeasons,
    state.showDetails,
  ])
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Film,
  Loader2,
  RefreshCw,
  Search,
  Tv,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { api, type ItemDetail } from "@/lib/api"
import { useLibrary, useShows } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useLibraryRows, type Row } from "./useLibraryRows"

const ROW = 28

interface SidebarProps {
  selectedId: string | null
  selectedItem: ItemDetail | undefined
  onSelect: (id: string) => void
}

export function Sidebar({ selectedId, selectedItem, onSelect }: SidebarProps) {
  const library = useLibrary()
  const [query, setQuery] = useState("")
  const [collapsedLibraries, setCollapsedLibraries] = useState<Set<string>>(
    () => new Set()
  )
  const [expandedShows, setExpandedShows] = useState<Set<string>>(
    () => new Set()
  )
  const [collapsedSeasons, setCollapsedSeasons] = useState<Set<string>>(
    () => new Set()
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const expandedIds = useMemo(() => [...expandedShows], [expandedShows])
  const showQueries = useShows(expandedIds)
  const showDetails = useMemo(() => {
    const m = new Map<
      string,
      ReturnType<typeof api.show> extends Promise<infer T>
        ? T | undefined
        : never
    >()
    expandedIds.forEach((id, i) => m.set(id, showQueries[i]?.data))
    return m
  }, [expandedIds, showQueries])

  const rows = useLibraryRows(library.data, {
    query,
    collapsedLibraries,
    expandedShows,
    collapsedSeasons,
    showDetails,
  })

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12,
    getItemKey: (i) => rows[i]!.key,
  })

  // Reveal the selected item: expand its show and season, then scroll to it.
  const revealedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId || !selectedItem || selectedItem.id !== selectedId) return
    if (revealedFor.current === selectedId) return
    if (selectedItem.showId) {
      const showId = selectedItem.showId
      setExpandedShows((s) => (s.has(showId) ? s : new Set(s).add(showId)))
      setCollapsedSeasons((s) => {
        const key = `${showId}:${selectedItem.season}`
        if (!s.has(key)) return s
        const n = new Set(s)
        n.delete(key)
        return n
      })
    }
    const idx = rows.findIndex(
      (r) =>
        (r.type === "movie" && r.item.id === selectedId) ||
        (r.type === "episode" && r.episode.id === selectedId)
    )
    if (idx >= 0) {
      revealedFor.current = selectedId
      virtualizer.scrollToIndex(idx, { align: "center" })
    }
  }, [selectedId, selectedItem, rows, virtualizer])

  const toggleLibrary = useCallback((id: string) => {
    setCollapsedLibraries((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])
  const toggleShow = useCallback((id: string) => {
    setExpandedShows((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])
  const toggleSeason = useCallback((key: string) => {
    setCollapsedSeasons((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])

  const rescan = async () => {
    try {
      await api.rescan()
      toast("Rescanning the library")
      void library.refetch()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const scanning = library.data?.scanning ?? false

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex h-full w-full flex-col">
      <div className="border-sidebar-border flex items-center gap-2 border-b px-2 py-2">
        <div className="relative flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("")
                inputRef.current?.blur()
              }
            }}
            placeholder="Search titles"
            aria-label="Search titles"
            dir="auto"
            className="border-input bg-input/30 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/40 h-7 w-full rounded-md border pr-7 pl-7 text-[13px] outline-none focus-visible:ring-2"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={rescan}
                disabled={scanning}
                aria-label="Rescan library"
              />
            }
          >
            {scanning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {scanning ? "Scanning" : "Rescan library"}
          </TooltipContent>
        </Tooltip>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {library.isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 px-3 py-3 text-xs">
            <Loader2 className="size-3.5 animate-spin" /> Loading library
          </div>
        ) : library.error ? (
          <div className="text-destructive px-3 py-3 text-xs">
            {(library.error as Error).message}
          </div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index]!
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  className="absolute top-0 left-0 w-full"
                  style={{
                    height: v.size,
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  <RowView
                    row={row}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    onToggleLibrary={toggleLibrary}
                    onToggleShow={toggleShow}
                    onToggleSeason={toggleSeason}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="border-sidebar-border text-muted-foreground flex items-center justify-between border-t px-3 py-1.5 text-[11px]">
        <span>
          {library.data
            ? `${library.data.libraries.reduce((n, l) => n + l.items.length, 0)} titles`
            : ""}
        </span>
        <span>
          {scanning
            ? "scanning"
            : library.data?.scannedAt
              ? `scanned ${relativeTime(library.data.scannedAt)}`
              : ""}
        </span>
      </div>
    </aside>
  )
}

function relativeTime(iso: string): string {
  const diff = Math.max(0, Date.now() - Date.parse(iso))
  const m = Math.round(diff / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

interface RowViewProps {
  row: Row
  selectedId: string | null
  onSelect: (id: string) => void
  onToggleLibrary: (id: string) => void
  onToggleShow: (id: string) => void
  onToggleSeason: (key: string) => void
}

function RowView({
  row,
  selectedId,
  onSelect,
  onToggleLibrary,
  onToggleShow,
  onToggleSeason,
}: RowViewProps) {
  const base =
    "flex h-7 w-full items-center gap-1.5 truncate text-left text-[13px] leading-7 outline-none select-none"
  switch (row.type) {
    case "library":
      return (
        <button
          type="button"
          onClick={() => onToggleLibrary(row.libraryId)}
          className={cn(
            base,
            "text-muted-foreground hover:text-foreground px-2 text-[11px] font-semibold tracking-wide uppercase"
          )}
        >
          {row.collapsed ? (
            <ChevronRight className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{row.name}</span>
          <span className="ml-auto font-normal tabular-nums">{row.count}</span>
        </button>
      )
    case "movie": {
      const active = row.item.id === selectedId
      return (
        <button
          type="button"
          onClick={() => onSelect(row.item.id)}
          className={cn(
            base,
            "hover:bg-sidebar-accent pr-2 pl-3",
            active && "bg-primary/15 text-primary hover:bg-primary/20"
          )}
          aria-current={active ? "true" : undefined}
        >
          <Film className="size-3.5 shrink-0 opacity-60" />
          <span className="truncate" dir="auto">
            {row.item.title}
          </span>
          {row.item.year && (
            <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
              {row.item.year}
            </span>
          )}
        </button>
      )
    }
    case "show":
      return (
        <button
          type="button"
          onClick={() => onToggleShow(row.item.id)}
          className={cn(
            base,
            "hover:bg-sidebar-accent pr-2 pl-3",
            row.expanded && "text-foreground"
          )}
          aria-expanded={row.expanded}
        >
          {row.loading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin opacity-60" />
          ) : row.expanded ? (
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          ) : (
            <Tv className="size-3.5 shrink-0 opacity-60" />
          )}
          <span className="truncate" dir="auto">
            {row.item.title}
          </span>
          <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
            {row.item.year ?? ""}
            {row.item.episodeCount ? ` · ${row.item.episodeCount}` : ""}
          </span>
        </button>
      )
    case "season": {
      const key = `${row.showId}:${row.number}`
      return (
        <button
          type="button"
          onClick={() => onToggleSeason(key)}
          className={cn(
            base,
            "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground pr-2 pl-6 text-[12px]"
          )}
          aria-expanded={row.expanded}
        >
          {row.expanded ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
          <span className="truncate">
            {row.number === 0 ? "Specials" : `Season ${row.number}`}
            {row.title ? ` · ${row.title}` : ""}
          </span>
          <span className="ml-auto tabular-nums">{row.count}</span>
        </button>
      )
    }
    case "episode": {
      const active = row.episode.id === selectedId
      return (
        <button
          type="button"
          onClick={() => onSelect(row.episode.id)}
          className={cn(
            base,
            "hover:bg-sidebar-accent pr-2 pl-9",
            active && "bg-primary/15 text-primary hover:bg-primary/20"
          )}
          aria-current={active ? "true" : undefined}
        >
          <Clapperboard className="size-3 shrink-0 opacity-50" />
          <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
            E{String(row.episode.episode).padStart(2, "0")}
            {row.episode.episodeEnd
              ? `-${String(row.episode.episodeEnd).padStart(2, "0")}`
              : ""}
          </span>
          <span className="truncate" dir="auto">
            {row.episode.title ?? `Episode ${row.episode.episode}`}
          </span>
        </button>
      )
    }
    case "empty":
      return (
        <div className="text-muted-foreground px-3 text-xs leading-7">
          {row.text}
        </div>
      )
  }
}

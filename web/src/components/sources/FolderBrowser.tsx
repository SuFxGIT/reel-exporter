import { useEffect, useId, useState } from "react"
import {
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderOpen,
  Loader2,
  X,
} from "lucide-react"
import type { LibrarySelection, Source } from "@/lib/api"
import { useBrowse } from "@/lib/queries"
import {
  blockedBy,
  displayName,
  lastSegment,
  parentOf,
  renameSelection,
  toggleSelection,
  type BlockReason,
} from "@/lib/sources"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"

interface Props {
  source: Source
  selection: LibrarySelection[]
  onChange: (next: LibrarySelection[]) => void
  onRenamingChange?: (renaming: boolean) => void
}

export function FolderBrowser({
  source,
  selection,
  onChange,
  onRenamingChange,
}: Props) {
  const [relPath, setRelPath] = useState(".")
  const [renaming, setRenaming] = useState<string | null>(null)
  const browse = useBrowse(source.exists ? source.id : null, relPath)

  useEffect(() => {
    onRenamingChange?.(renaming !== null)
  }, [renaming, onRenamingChange])

  if (!source.exists) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
        <Folder className="size-8 opacity-40" />
        <p>This path is not mounted in the container.</p>
        <p className="text-xs">
          Mount it and restart the container, or remove the source.
        </p>
      </div>
    )
  }

  const crumbs = relPath === "." ? [] : relPath.split("/")
  const rootLabel = lastSegment(source.path)
  const toggle = (rel: string, on: boolean) =>
    onChange(toggleSelection(selection, rel, on))
  const isSelected = (rel: string) => selection.some((l) => l.relPath === rel)
  const sortedSelection = [...selection].sort((a, b) =>
    a.relPath < b.relPath ? -1 : 1
  )
  const data = browse.data

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="Folder path"
        className="flex items-center gap-1 border-b px-2 py-1.5 text-[13px]"
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Up one folder"
          disabled={relPath === "."}
          onClick={() => setRelPath(data?.parentPath ?? parentOf(relPath))}
        >
          <CornerLeftUp />
        </Button>
        <Crumb
          label={rootLabel}
          current={relPath === "."}
          onClick={() => setRelPath(".")}
        />
        {crumbs.map((seg, i) => {
          const target = crumbs.slice(0, i + 1).join("/")
          return (
            <span key={target} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="text-muted-foreground size-3 shrink-0" />
              <Crumb
                label={seg}
                current={i === crumbs.length - 1}
                onClick={() => setRelPath(target)}
              />
            </span>
          )
        })}
        {browse.isFetching && data && (
          <Loader2 className="text-muted-foreground ml-1 size-3 shrink-0 animate-spin" />
        )}
      </nav>

      <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        <span className="text-muted-foreground text-[11px]">Libraries:</span>
        {sortedSelection.length === 0 && (
          <span className="text-muted-foreground text-[11px]">
            none yet, tick folders below
          </span>
        )}
        {sortedSelection.map((l) => (
          <Chip
            key={l.relPath}
            entry={l}
            sourcePath={source.path}
            renaming={renaming === l.relPath}
            onRename={() => setRenaming(l.relPath)}
            onCommit={(name) => {
              onChange(renameSelection(selection, l.relPath, name))
              setRenaming(null)
            }}
            onCancel={() => setRenaming(null)}
            onRemove={() => toggle(l.relPath, false)}
            onOpen={() => setRelPath(l.relPath)}
          />
        ))}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        <FolderRow
          label="This folder"
          detail={relPath === "." ? source.path : lastSegment(relPath)}
          checked={isSelected(relPath)}
          block={blockedBy(relPath, selection, source.path)}
          videoCount={data?.videoCount}
          onToggle={(on) => toggle(relPath, on)}
          icon="open"
        />
        {browse.isLoading && !data && (
          <li className="text-muted-foreground flex items-center gap-2 px-3 py-3 text-xs">
            <Loader2 className="size-3.5 animate-spin" /> Reading folders
          </li>
        )}
        {browse.error && (
          <li className="text-destructive flex items-center justify-between gap-2 px-3 py-2 text-xs">
            <span>{(browse.error as Error).message}</span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => browse.refetch()}
            >
              Retry
            </Button>
          </li>
        )}
        {data && data.folders.length === 0 && !browse.error && (
          <li className="text-muted-foreground px-3 py-2 text-xs">
            No sub-folders here.
          </li>
        )}
        <div className={cn(browse.isFetching && data && "opacity-60")}>
          {data?.folders.map((f) => (
            <FolderRow
              key={f.relPath}
              label={f.name}
              checked={isSelected(f.relPath)}
              block={blockedBy(f.relPath, selection, source.path)}
              videoCount={f.videoCount}
              onToggle={(on) => toggle(f.relPath, on)}
              onOpen={() => setRelPath(f.relPath)}
              icon={isSelected(f.relPath) ? "open" : "closed"}
            />
          ))}
        </div>
        {data?.truncated && (
          <li className="text-muted-foreground px-3 py-2 text-xs">
            Only the first 2000 folders are listed.
          </li>
        )}
      </ul>
    </div>
  )
}

function Crumb({
  label,
  current,
  onClick,
}: {
  label: string
  current: boolean
  onClick: () => void
}) {
  if (current) {
    return (
      <span
        aria-current="page"
        className="max-w-40 truncate font-medium"
        dir="auto"
      >
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground max-w-40 truncate rounded px-0.5"
      dir="auto"
    >
      {label}
    </button>
  )
}

function FolderRow({
  label,
  detail,
  checked,
  block,
  videoCount,
  onToggle,
  onOpen,
  icon,
}: {
  label: string
  detail?: string
  checked: boolean
  block: BlockReason | null
  videoCount?: number
  onToggle: (on: boolean) => void
  onOpen?: () => void
  icon: "open" | "closed"
}) {
  const id = useId()
  const why = block
    ? block.kind === "inside"
      ? `Inside library ${block.name}`
      : `Contains library ${block.name}`
    : undefined
  return (
    <li className="hover:bg-muted/40 flex h-8 items-center gap-1 pr-1 pl-3 text-[13px]">
      <label
        htmlFor={id}
        title={why}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          block ? "cursor-not-allowed opacity-50" : "cursor-pointer"
        )}
      >
        <Checkbox
          id={id}
          checked={checked}
          indeterminate={block?.kind === "contains"}
          disabled={Boolean(block)}
          onCheckedChange={(on) => onToggle(Boolean(on))}
          aria-label={`Import ${label} as a library`}
        />
        {icon === "open" ? (
          <FolderOpen
            className={cn(
              "size-3.5 shrink-0",
              checked ? "text-primary" : "opacity-60"
            )}
          />
        ) : (
          <Folder className="size-3.5 shrink-0 opacity-60" />
        )}
        <span className="truncate" dir="auto">
          {label}
        </span>
        {detail && (
          <span
            className="text-muted-foreground truncate text-[11px]"
            dir="auto"
          >
            {detail}
          </span>
        )}
        {videoCount !== undefined && videoCount > 0 && (
          <span className="tnum text-muted-foreground shrink-0 text-[11px]">
            {videoCount} {videoCount === 1 ? "video" : "videos"}
          </span>
        )}
      </label>
      {onOpen && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Open ${label}`}
          onClick={onOpen}
        >
          <ChevronRight />
        </Button>
      )}
    </li>
  )
}

function Chip({
  entry,
  sourcePath,
  renaming,
  onRename,
  onCommit,
  onCancel,
  onRemove,
  onOpen,
}: {
  entry: LibrarySelection
  sourcePath: string
  renaming: boolean
  onRename: () => void
  onCommit: (name: string | undefined) => void
  onCancel: () => void
  onRemove: () => void
  onOpen: () => void
}) {
  const name = displayName(entry, sourcePath)
  const [value, setValue] = useState(name)
  useEffect(() => {
    if (renaming) setValue(entry.name ?? name)
  }, [renaming, entry.name, name])
  const title = entry.relPath === "." ? sourcePath : entry.relPath
  if (renaming) {
    return (
      <input
        autoFocus
        value={value}
        dir="auto"
        aria-label={`Name for ${title}`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            onCommit(value.trim() || undefined)
          } else if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
        onBlur={() => onCommit(value.trim() || undefined)}
        className="border-primary/50 bg-input/30 h-6 w-40 rounded-full border px-2 text-[12px] outline-none"
      />
    )
  }
  return (
    <span
      className="bg-primary/10 text-primary flex h-6 max-w-56 items-center gap-1 rounded-full pr-1 pl-2 text-[12px]"
      title={title}
    >
      <button
        type="button"
        onClick={onRename}
        onDoubleClick={onOpen}
        className="truncate hover:underline"
        dir="auto"
        aria-label={`Rename ${name}`}
      >
        {name}
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="hover:bg-primary/20 rounded-full p-0.5"
        aria-label={`Remove ${name} from libraries`}
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

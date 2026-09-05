import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import {
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Repeat,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { api, exportLabel, type Capture, type Job } from "@/lib/api"
import { useCaptures, useInvalidate } from "@/lib/queries"
import { formatBytes, formatTime } from "@/lib/time"
import { cn } from "@/lib/utils"
import { useReorder } from "@/hooks/useReorder"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface Props {
  itemId: string
  activeJob: Job | undefined
}

const STRIP = "h-[96px]"

/** "Intro cut.mp4" -> "Intro cut" */
const stemOf = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

export function CapturesStrip({ itemId, activeJob }: Props) {
  const captures = useCaptures(itemId)
  const invalidate = useInvalidate()
  const serverList = useMemo(
    () => captures.data?.captures ?? [],
    [captures.data]
  )

  // Optimistic order while the server is being told about a drag.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null)
  useEffect(() => setLocalOrder(null), [serverList])
  const list = useMemo(() => {
    if (!localOrder) return serverList
    const byRel = new Map(serverList.map((c) => [c.relPath, c]))
    const ordered = localOrder.flatMap((r) => {
      const c = byRel.get(r)
      if (c) byRel.delete(r)
      return c ? [c] : []
    })
    return [...ordered, ...byRel.values()]
  }, [localOrder, serverList])

  const reorder = useReorder(list.length, (from, to) => {
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    const relPaths = next.map((c) => c.relPath)
    setLocalOrder(relPaths)
    api
      .reorderCaptures(itemId, relPaths)
      .then(() => invalidate.captures(itemId))
      .catch((err: Error) => {
        setLocalOrder(null)
        toast.error("Could not save the order", { description: err.message })
      })
  })
  const drag = reorder.drag
  // Full-row index the drop indicator sits before; n means after the last tile.
  const indicatorAt =
    drag && drag.to !== drag.from
      ? drag.to < drag.from
        ? drag.to
        : drag.to + 1
      : -1

  const otherJobs = (captures.data?.jobs ?? []).filter(
    (j) => j.id !== activeJob?.id
  )
  const jobs = [
    ...(activeJob &&
    (activeJob.status === "queued" || activeJob.status === "running")
      ? [activeJob]
      : []),
    ...otherJobs,
  ]

  const cancel = async (job: Job) => {
    try {
      await api.cancelJob(job.id)
      toast("Export cancelled")
      void invalidate.captures(itemId)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  if (jobs.length === 0 && list.length === 0) {
    return (
      <div
        className={cn(
          STRIP,
          "text-muted-foreground flex shrink-0 items-center px-3 text-xs"
        )}
      >
        {captures.isLoading
          ? "Loading captures"
          : "Screenshots, clips and GIFs you save for this title appear here."}
      </div>
    )
  }

  return (
    <div
      className={cn(
        STRIP,
        "flex shrink-0 items-stretch gap-2 overflow-x-auto px-2 py-2"
      )}
    >
      {jobs.map((job) => (
        <div
          key={job.id}
          className="border-primary/40 bg-primary/10 flex w-44 shrink-0 flex-col justify-between rounded-md border p-2 text-[11px]"
        >
          <div className="flex items-center justify-between gap-1">
            <span className="flex items-center gap-1 truncate">
              <Loader2 className="text-primary size-3 animate-spin" />
              {job.status === "queued"
                ? "Queued"
                : job.type === "clip"
                  ? "Exporting"
                  : `Exporting ${exportLabel[job.type]}`}
              <span className="tnum text-muted-foreground">
                {formatTime(job.params.start, false)}–
                {formatTime(job.params.end, false)}
              </span>
            </span>
            <button
              type="button"
              onClick={() => cancel(job)}
              className="text-muted-foreground hover:text-foreground rounded p-0.5"
              aria-label="Cancel export"
            >
              <X className="size-3" />
            </button>
          </div>
          <Progress value={Math.round(job.progress * 100)} className="h-1.5" />
        </div>
      ))}
      {list.map((c, i) => (
        <span key={c.relPath} className="contents">
          {indicatorAt === i && <DropIndicator />}
          <CaptureTile
            capture={c}
            itemId={itemId}
            dragProps={reorder.bind(i)}
            dragging={drag?.from === i}
            dragStyle={
              drag?.from === i
                ? { transform: `translateX(${drag.dx}px)` }
                : undefined
            }
          />
        </span>
      ))}
      {indicatorAt === list.length && <DropIndicator />}
    </div>
  )
}

function DropIndicator() {
  return (
    <span className="relative w-0 shrink-0" aria-hidden>
      <span className="bg-primary absolute top-0 -left-[5px] h-full w-0.5 rounded" />
    </span>
  )
}

function KindIcon({ kind }: { kind: Capture["kind"] }) {
  if (kind === "clip") return <Film className="size-3 shrink-0 opacity-70" />
  if (kind === "gif") return <Repeat className="size-3 shrink-0 opacity-70" />
  return <ImageIcon className="size-3 shrink-0 opacity-70" />
}

function CaptureTile({
  capture,
  itemId,
  dragProps,
  dragging = false,
  dragStyle,
}: {
  capture: Capture
  itemId: string
  dragProps?: ReturnType<ReturnType<typeof useReorder>["bind"]>
  dragging?: boolean
  dragStyle?: CSSProperties
}) {
  const invalidate = useInvalidate()
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const stem = stemOf(capture.name)

  // The delete button asks once, then forgets after a few seconds.
  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 4000)
    return () => clearTimeout(t)
  }, [confirm])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const startEdit = () => {
    setDraft(stem)
    setEditing(true)
  }

  const commit = async () => {
    const next = draft.trim()
    if (!editing || saving) return
    if (!next || next === stem) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      const renamed = await api.renameCapture(itemId, capture, next)
      toast(`Renamed to ${renamed.name}`)
      setEditing(false)
      void invalidate.captures(itemId)
    } catch (err) {
      toast.error("Could not rename the file", {
        description: (err as Error).message,
      })
      inputRef.current?.focus()
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirm) {
      setConfirm(true)
      return
    }
    setDeleting(true)
    try {
      await api.deleteCapture(capture)
      toast(`Deleted ${capture.name}`)
      void invalidate.captures(itemId)
    } catch (err) {
      toast.error("Could not delete the file", {
        description: (err as Error).message,
      })
      setDeleting(false)
      setConfirm(false)
    }
  }

  return (
    <div
      {...dragProps}
      style={dragStyle}
      className={cn(
        "group bg-muted/40 relative flex h-full w-[104px] shrink-0 flex-col overflow-hidden rounded-md border select-none",
        dragProps && !editing && "cursor-grab",
        dragging && "ring-primary z-10 cursor-grabbing opacity-80 ring-2",
        deleting && "opacity-50"
      )}
    >
      <div className="relative min-h-0 flex-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={capture.url}
                target="_blank"
                rel="noreferrer"
                draggable={false}
                className="focus-visible:ring-ring block h-full w-full outline-none focus-visible:ring-2"
              />
            }
          >
            <img
              src={capture.thumbUrl}
              alt=""
              loading="lazy"
              draggable={false}
              className="pointer-events-none h-full w-full object-cover"
            />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-sm">
            <span dir="auto">{capture.name}</span>
            <span className="text-background/70">
              {" "}
              · {formatBytes(capture.size)}
              {dragProps ? " · drag to reorder" : ""}
            </span>
          </TooltipContent>
        </Tooltip>
        <div
          className={cn(
            "absolute right-1 bottom-1 flex items-center gap-1 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
            confirm ? "opacity-100" : "opacity-0"
          )}
        >
          {confirm ? (
            <Button
              variant="destructive"
              size="xs"
              onClick={remove}
              disabled={deleting}
              aria-label={`Confirm deleting ${capture.name}`}
            >
              Delete?
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                size="icon-xs"
                onClick={startEdit}
                aria-label={`Rename ${capture.name}`}
              >
                <Pencil />
              </Button>
              <Button
                variant="secondary"
                size="icon-xs"
                render={<a href={capture.downloadUrl} aria-label="Download" />}
              >
                <Download />
              </Button>
              <Button
                variant="secondary"
                size="icon-xs"
                onClick={remove}
                aria-label={`Delete ${capture.name}`}
              >
                <Trash2 />
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="flex h-5 shrink-0 items-center gap-1 border-t px-1 text-[11px]">
        <KindIcon kind={capture.kind} />
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            dir="auto"
            disabled={saving}
            aria-label={`New name for ${capture.name}`}
            onChange={(e) => setDraft(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void commit()
              } else if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                setEditing(false)
              }
            }}
            onBlur={() => void commit()}
            className="bg-input/40 min-w-0 flex-1 rounded px-1 outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={startEdit}
            title="Rename"
            dir="auto"
            className="hover:text-foreground min-w-0 flex-1 truncate text-left"
          >
            {stem}
          </button>
        )}
      </div>
    </div>
  )
}

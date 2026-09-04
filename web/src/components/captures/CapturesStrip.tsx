import { useEffect, useState } from "react"
import {
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { api, type Capture, type Job } from "@/lib/api"
import { useCaptures, useInvalidate } from "@/lib/queries"
import { formatBytes, formatTime } from "@/lib/time"
import { cn } from "@/lib/utils"
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

export function CapturesStrip({ itemId, activeJob }: Props) {
  const captures = useCaptures(itemId)
  const invalidate = useInvalidate()
  const list = captures.data?.captures ?? []
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
      <div className="text-muted-foreground flex h-[76px] shrink-0 items-center px-3 text-xs">
        {captures.isLoading
          ? "Loading captures"
          : "Screenshots and clips you save for this title appear here."}
      </div>
    )
  }

  return (
    <div className="flex h-[76px] shrink-0 items-stretch gap-2 overflow-x-auto px-2 py-2">
      {jobs.map((job) => (
        <div
          key={job.id}
          className="border-primary/40 bg-primary/10 flex w-44 shrink-0 flex-col justify-between rounded-md border p-2 text-[11px]"
        >
          <div className="flex items-center justify-between gap-1">
            <span className="flex items-center gap-1 truncate">
              <Loader2 className="text-primary size-3 animate-spin" />
              {job.status === "queued" ? "Queued" : "Exporting"}
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
      {list.map((c) => (
        <CaptureTile key={c.relPath} capture={c} itemId={itemId} />
      ))}
    </div>
  )
}

function CaptureTile({
  capture,
  itemId,
}: {
  capture: Capture
  itemId: string
}) {
  const invalidate = useInvalidate()
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // The delete button asks once, then forgets after a few seconds.
  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 4000)
    return () => clearTimeout(t)
  }, [confirm])

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
      className={cn(
        "group bg-muted/40 relative h-full w-[104px] shrink-0 overflow-hidden rounded-md border",
        deleting && "opacity-50"
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <a
              href={capture.url}
              target="_blank"
              rel="noreferrer"
              className="focus-visible:ring-ring block h-full w-full outline-none focus-visible:ring-2"
            />
          }
        >
          <img
            src={capture.thumbUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          <span dir="auto">{capture.name}</span>
          <span className="text-background/70">
            {" "}
            · {formatBytes(capture.size)}
          </span>
        </TooltipContent>
      </Tooltip>
      <span className="pointer-events-none absolute top-1 left-1 rounded bg-black/60 p-0.5 text-white/90">
        {capture.kind === "clip" ? (
          <Film className="size-3" />
        ) : (
          <ImageIcon className="size-3" />
        )}
      </span>
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
  )
}

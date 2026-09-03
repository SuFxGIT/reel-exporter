import { Download, Film, Image as ImageIcon, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { api, type Capture, type Job } from "@/lib/api"
import { useCaptures, useInvalidate } from "@/lib/queries"
import { formatBytes, formatTime } from "@/lib/time"
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
        <CaptureTile key={c.name} capture={c} />
      ))}
    </div>
  )
}

function CaptureTile({ capture }: { capture: Capture }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={capture.url}
            target="_blank"
            rel="noreferrer"
            className="group bg-muted/40 focus-visible:ring-ring relative block h-full w-[104px] shrink-0 overflow-hidden rounded-md border outline-none focus-visible:ring-2"
          />
        }
      >
        <img
          src={capture.thumbUrl}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
        <span className="absolute top-1 left-1 rounded bg-black/60 p-0.5 text-white/90">
          {capture.kind === "clip" ? (
            <Film className="size-3" />
          ) : (
            <ImageIcon className="size-3" />
          )}
        </span>
        <Button
          variant="secondary"
          size="icon-xs"
          className="absolute right-1 bottom-1 opacity-0 transition-opacity group-hover:opacity-100"
          render={
            <a
              href={capture.downloadUrl}
              aria-label="Download"
              onClick={(e) => e.stopPropagation()}
            />
          }
        >
          <Download />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        <span dir="auto">{capture.name}</span>
        <span className="text-background/70">
          {" "}
          · {formatBytes(capture.size)}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

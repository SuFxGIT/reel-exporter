import { useEffect, useState, type RefObject } from "react"
import { frameUrl } from "@/lib/api"
import { formatTime } from "@/lib/time"

export interface HoverState {
  t: number
  x: number
}

interface Props {
  itemId: string
  hasVideo: boolean
  containerRef: RefObject<HTMLDivElement | null>
  minimapRef: RefObject<HTMLDivElement | null>
  hover: HoverState | null
  ready: boolean
}

/** Layout for the wavesurfer minimap + waveform, plus the hover thumbnail. */
export function Timeline({
  itemId,
  hasVideo,
  containerRef,
  minimapRef,
  hover,
  ready,
}: Props) {
  return (
    <div className="relative shrink-0 select-none">
      <div
        ref={minimapRef}
        className="rv-minimap bg-background/60 h-10 border-b"
      />
      <div className="relative">
        <div ref={containerRef} className="rv-wave" />
        {!ready && (
          <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-xs">
            Preparing timeline
          </div>
        )}
        {hover && hasVideo && (
          <HoverThumb
            itemId={itemId}
            hover={hover}
            containerRef={containerRef}
          />
        )}
      </div>
    </div>
  )
}

function HoverThumb({
  itemId,
  hover,
  containerRef,
}: {
  itemId: string
  hover: HoverState
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  useEffect(() => {
    const id = window.setTimeout(
      () => setUrl(frameUrl(itemId, hover.t, 320)),
      120
    )
    return () => window.clearTimeout(id)
  }, [itemId, hover.t])
  const width = 160
  const containerWidth = containerRef.current?.clientWidth ?? 0
  const left = Math.min(
    Math.max(hover.x - width / 2, 4),
    Math.max(4, containerWidth - width - 4)
  )
  return (
    <div
      className="border-border bg-popover pointer-events-none absolute bottom-full z-10 mb-1 overflow-hidden rounded-md border shadow-lg"
      style={{ left, width }}
    >
      <div className="aspect-video w-full bg-black">
        {url && (
          <img
            src={url}
            alt=""
            onLoad={() => setLoaded(url)}
            className="h-full w-full object-contain"
            style={{ opacity: loaded === url ? 1 : 0.4 }}
          />
        )}
      </div>
      <div className="tnum text-muted-foreground px-1.5 py-0.5 text-center text-[10px]">
        {formatTime(hover.t)}
      </div>
    </div>
  )
}

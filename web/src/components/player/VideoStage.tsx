import { useEffect, useRef, useState, type RefObject } from "react"
import { Loader2, VolumeX } from "lucide-react"
import type { MediaState } from "@/hooks/useMediaState"
import { cn } from "@/lib/utils"

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>
  media: MediaState
  hasVideo: boolean
  error: string | null
  notice?: string | null
  onTogglePlay: () => void
  onToggleFullscreen: () => void
}

export function VideoStage({
  videoRef,
  media,
  hasVideo,
  error,
  notice,
  onTogglePlay,
  onToggleFullscreen,
}: Props) {
  const clickTimer = useRef<number | null>(null)
  const [slow, setSlow] = useState(false)

  // Show the seeking indicator only when a seek takes a while (transcoder restart).
  useEffect(() => {
    if (!media.seeking && !media.waiting) {
      setSlow(false)
      return
    }
    const id = window.setTimeout(() => setSlow(true), 400)
    return () => window.clearTimeout(id)
  }, [media.seeking, media.waiting])

  const onClick = () => {
    if (clickTimer.current) return
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      onTogglePlay()
    }, 200)
  }
  const onDoubleClick = () => {
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    onToggleFullscreen()
  }

  return (
    <div
      data-stage
      className="relative flex min-h-0 flex-1 items-center justify-center bg-black select-none"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <video
        ref={videoRef}
        className={cn("h-full w-full object-contain", !hasVideo && "opacity-0")}
        playsInline
        preload="auto"
        crossOrigin="anonymous"
      />
      {!hasVideo && (
        <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2">
          <VolumeX className="size-8" />
          <p className="text-sm">
            This file has no video stream. Audio plays, but screenshots are
            unavailable.
          </p>
        </div>
      )}
      {slow && !error && (
        <div className="absolute top-3 right-3 flex items-center gap-2 rounded-md bg-black/60 px-2.5 py-1.5 text-xs text-white/80">
          <Loader2 className="size-3.5 animate-spin" />{" "}
          {media.seeking ? "Seeking" : "Buffering"}
        </div>
      )}
      {notice && !error && (
        <div className="absolute bottom-3 left-3 rounded-md bg-black/60 px-2.5 py-1.5 text-xs text-amber-300">
          {notice}
        </div>
      )}
      {error && (
        <div className="bg-destructive/20 text-destructive absolute inset-x-0 bottom-3 mx-auto w-fit rounded-md px-3 py-1.5 text-xs">
          {error}
        </div>
      )}
    </div>
  )
}

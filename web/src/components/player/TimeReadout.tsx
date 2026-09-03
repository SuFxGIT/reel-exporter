import { useEffect, useRef } from "react"
import type { PlaybackClock } from "@/hooks/usePlaybackClock"
import { formatTime } from "@/lib/time"

interface Props {
  clock: PlaybackClock
  duration: number
}

/** Writes the current time straight into the DOM so it can update at frame rate. */
export function TimeReadout({ clock, duration }: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const update = (t: number) => {
      if (ref.current) ref.current.textContent = formatTime(t)
    }
    update(clock.now())
    return clock.subscribe(update)
  }, [clock])
  return (
    <span className="tnum text-foreground/90 text-[13px]">
      <span ref={ref}>{formatTime(clock.now())}</span>
      <span className="text-muted-foreground">
        {" "}
        / {formatTime(duration, false)}
      </span>
    </span>
  )
}

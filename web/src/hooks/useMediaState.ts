import { useEffect, useState, type RefObject } from "react"

export interface MediaState {
  paused: boolean
  muted: boolean
  volume: number
  duration: number
  seeking: boolean
  waiting: boolean
  ended: boolean
  ready: boolean
}

const initial: MediaState = {
  paused: true,
  muted: false,
  volume: 1,
  duration: 0,
  seeking: false,
  waiting: false,
  ended: false,
  ready: false,
}

/** Mirrors the coarse state of a video element (never per-frame values). */
export function useMediaState(
  videoRef: RefObject<HTMLVideoElement | null>
): MediaState {
  const [state, setState] = useState<MediaState>(initial)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const read = () =>
      setState({
        paused: v.paused,
        muted: v.muted,
        volume: v.volume,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        seeking: v.seeking,
        waiting: v.readyState < 3 && !v.paused,
        ended: v.ended,
        ready: v.readyState >= 2,
      })
    const events = [
      "play",
      "pause",
      "volumechange",
      "durationchange",
      "seeking",
      "seeked",
      "waiting",
      "playing",
      "canplay",
      "loadedmetadata",
      "ended",
      "emptied",
    ]
    for (const e of events) v.addEventListener(e, read)
    read()
    return () => {
      for (const e of events) v.removeEventListener(e, read)
    }
  }, [videoRef])
  return state
}

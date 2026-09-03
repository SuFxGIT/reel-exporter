import { useEffect, useMemo, useRef, type RefObject } from "react"

type Listener = (t: number) => void

export interface PlaybackClock {
  /** Exact presentation time of the frame on screen when known, else currentTime. */
  now: () => number
  subscribe: (fn: Listener) => () => void
}

/**
 * High-rate clock for the readout and the timeline cursor. Uses
 * requestVideoFrameCallback for the exact PTS of the displayed frame when the
 * browser supports it, falling back to requestAnimationFrame.
 */
export function usePlaybackClock(
  videoRef: RefObject<HTMLVideoElement | null>
): PlaybackClock {
  const listeners = useRef(new Set<Listener>())
  const frameTime = useRef<number | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const emit = (t: number) => {
      for (const fn of listeners.current) fn(t)
    }
    const hasVfc =
      typeof (
        video as HTMLVideoElement & { requestVideoFrameCallback?: unknown }
      ).requestVideoFrameCallback === "function"
    let raf = 0
    let vfc = 0
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      frameTime.current = meta.mediaTime
      emit(meta.mediaTime)
      vfc = video.requestVideoFrameCallback(onFrame)
    }
    const tick = () => {
      emit(video.currentTime)
      raf = requestAnimationFrame(tick)
    }
    const onPlay = () => {
      if (!hasVfc) raf = requestAnimationFrame(tick)
    }
    const onPause = () => cancelAnimationFrame(raf)
    const onSeeking = () => {
      frameTime.current = null
      emit(video.currentTime)
    }
    const onSeeked = () => emit(video.currentTime)
    const onTime = () => {
      if (video.paused) emit(frameTime.current ?? video.currentTime)
    }
    if (hasVfc) vfc = video.requestVideoFrameCallback(onFrame)
    video.addEventListener("play", onPlay)
    video.addEventListener("pause", onPause)
    video.addEventListener("seeking", onSeeking)
    video.addEventListener("seeked", onSeeked)
    video.addEventListener("timeupdate", onTime)
    return () => {
      cancelAnimationFrame(raf)
      if (hasVfc) video.cancelVideoFrameCallback(vfc)
      video.removeEventListener("play", onPlay)
      video.removeEventListener("pause", onPause)
      video.removeEventListener("seeking", onSeeking)
      video.removeEventListener("seeked", onSeeked)
      video.removeEventListener("timeupdate", onTime)
    }
  }, [videoRef])

  return useMemo(
    () => ({
      now: () => {
        const v = videoRef.current
        if (!v) return 0
        return v.seeking ? v.currentTime : (frameTime.current ?? v.currentTime)
      },
      subscribe: (fn: Listener) => {
        listeners.current.add(fn)
        return () => {
          listeners.current.delete(fn)
        }
      },
    }),
    [videoRef]
  )
}

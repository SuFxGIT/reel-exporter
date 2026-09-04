import { useEffect, useRef, useState, type RefObject } from "react"
import Hls, { type ErrorData } from "hls.js"

export interface HlsState {
  /** True once hls.js (or native HLS) has attached to the video element. */
  attached: boolean
  error: string | null
}

/**
 * Attaches an HLS source to the video element. The backend transcodes on demand, so
 * fragment timeouts are generous: a far seek can take a few seconds before data flows.
 */
export function useHls(
  videoRef: RefObject<HTMLVideoElement | null>,
  src: string | null,
  startPosition: number
): HlsState {
  const [state, setState] = useState<HlsState>({ attached: false, error: null })
  const startRef = useRef(startPosition)
  startRef.current = startPosition

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return
    setState({ attached: false, error: null })
    let hls: Hls | null = null
    let disposed = false

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 60,
        maxBufferHole: 0.5,
        startPosition: startRef.current > 0 ? startRef.current : -1,
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 65000,
            maxLoadTimeMs: 120000,
            timeoutRetry: {
              maxNumRetry: 3,
              retryDelayMs: 500,
              maxRetryDelayMs: 2000,
            },
            errorRetry: {
              maxNumRetry: 6,
              retryDelayMs: 500,
              maxRetryDelayMs: 4000,
            },
          },
        },
        manifestLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 20000,
            maxLoadTimeMs: 30000,
            timeoutRetry: {
              maxNumRetry: 2,
              retryDelayMs: 500,
              maxRetryDelayMs: 2000,
            },
            errorRetry: {
              maxNumRetry: 3,
              retryDelayMs: 500,
              maxRetryDelayMs: 2000,
            },
          },
        },
      })
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (!disposed) setState({ attached: true, error: null })
      })
      hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
        if (!hls || disposed) return
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad(startRef.current)
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError()
        } else {
          setState({ attached: true, error: data.details ?? "Playback failed" })
        }
      })
      hls.loadSource(src)
      hls.attachMedia(video)
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src
      if (startRef.current > 0) video.currentTime = startRef.current
      setState({ attached: true, error: null })
    } else {
      setState({
        attached: false,
        error: "This browser cannot play HLS streams.",
      })
    }

    return () => {
      disposed = true
      if (hls) {
        hls.destroy()
      } else {
        video.removeAttribute("src")
        video.load()
      }
      // Tell the server to stop this transcode now instead of at the idle timeout.
      void fetch(src.replace(/\/index\.m3u8.*$/, ""), {
        method: "DELETE",
        keepalive: true,
      }).catch(() => undefined)
    }
  }, [videoRef, src])

  return state
}

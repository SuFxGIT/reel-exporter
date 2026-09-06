import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { useHls } from "@/hooks/useHls"
import { useMediaState } from "@/hooks/useMediaState"
import { usePlaybackClock } from "@/hooks/usePlaybackClock"
import { useSelection, type Selection } from "@/hooks/useSelection"
import { useShortcuts } from "@/hooks/useShortcuts"
import { useTimeline, type ZoomState } from "@/hooks/useTimeline"
import { api, hlsUrl, type ItemDetail, exportLabel } from "@/lib/api"
import {
  GIF_MAX_SECONDS,
  maxWidthFor,
  shortSideFor,
  useExportOptions,
} from "@/lib/export-options"
import { stepFrames } from "@/lib/frame-step"
import { decodePeaks, useInvalidate, useJob, usePeaks } from "@/lib/queries"
import { CapturesStrip } from "@/components/captures/CapturesStrip"
import { Timeline, type HoverState } from "@/components/timeline/Timeline"
import { ControlBar, type PlayerActions } from "./ControlBar"
import { Header } from "./Header"
import { VideoStage } from "./VideoStage"

interface Props {
  item: ItemDetail
  onToggleSidebar: () => void
  onClose: () => void
}

const VOLUME_KEY = "reel-exporter:volume"
const MUTED_KEY = "reel-exporter:muted"
/** Reads a setting, falling back to the key used before the rename. */
const stored = (key: string): string | null =>
  localStorage.getItem(key) ??
  localStorage.getItem(key.replace("reel-exporter:", "reel-vault:"))

export function Player({ item, onToggleSidebar, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const minimapRef = useRef<HTMLDivElement>(null)
  const [audio, setAudio] = useState(item.defaultAudio)
  const resumeRef = useRef(0)
  const playable = item.hasVideo || item.audio.length > 0
  const src = useMemo(
    () => (playable ? hlsUrl(item.id, audio) : null),
    [playable, item.id, audio]
  )

  const hls = useHls(videoRef, src, resumeRef.current)
  const media = useMediaState(videoRef)
  const clock = usePlaybackClock(videoRef)
  const { selection, setSelection, setIn, setOut, clear } = useSelection(
    item.duration
  )
  const peaksQuery = usePeaks(item, audio)
  const peaks = useMemo(() => {
    const d = peaksQuery.data
    if (!d || d.pending || d.data.count === 0) return null
    return decodePeaks(d.data)
  }, [peaksQuery.data])
  const [zoom, setZoom] = useState<ZoomState>({ level: 0, fit: 0, max: 200 })
  const [hover, setHover] = useState<HoverState | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJob(jobId)
  const [shotBusy, setShotBusy] = useState(false)
  const invalidate = useInvalidate()
  const exportOptions = useExportOptions()
  const { screenshot: shotOpts, clip: clipOpts } = exportOptions

  useEffect(() => {
    setVideoEl(videoRef.current)
  }, [])

  // Restore volume once the element exists.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    try {
      const vol = stored(VOLUME_KEY)
      const muted = stored(MUTED_KEY)
      if (vol !== null) v.volume = Math.min(1, Math.max(0, Number(vol)))
      if (muted !== null) v.muted = muted === "1"
    } catch {
      /* storage unavailable */
    }
  }, [])

  const onSelectionChange = useCallback(
    (sel: Selection | null) => setSelection(sel),
    [setSelection]
  )
  const onHover = useCallback(
    (t: number | null, x: number) => setHover(t === null ? null : { t, x }),
    []
  )
  const onZoom = useCallback((z: ZoomState) => setZoom(z), [])

  const timeline = useTimeline({
    containerRef,
    minimapRef,
    video: videoEl,
    attached: hls.attached,
    duration: item.duration,
    peaks,
    selection,
    onSelectionChange,
    onHover,
    onZoom,
  })

  // Clip job outcome.
  const jobStatus = job.data?.status
  useEffect(() => {
    if (!job.data) return
    if (jobStatus === "done" && job.data.output) {
      const out = job.data.output
      toast.success(`${exportLabel[job.data.type]} saved`, {
        description: out.name,
        action: {
          label: "Open",
          onClick: () => window.open(out.url, "_blank"),
        },
      })
      void invalidate.captures(item.id)
      setJobId(null)
    } else if (jobStatus === "failed") {
      toast.error(`${exportLabel[job.data.type]} export failed`, {
        description: job.data.error ?? "Check the container logs.",
      })
      setJobId(null)
    } else if (jobStatus === "cancelled") {
      setJobId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobStatus])

  const exporting = jobStatus === "queued" || jobStatus === "running"

  const actions = useMemo<PlayerActions>(() => {
    const video = () => videoRef.current
    const clampT = (t: number) =>
      Math.min(Math.max(0, t), item.duration > 0 ? item.duration : t)
    return {
      togglePlay: () => {
        const v = video()
        if (!v) return
        if (v.paused) v.play().catch(() => undefined)
        else v.pause()
      },
      seekBy: (s) => {
        const v = video()
        if (v) v.currentTime = clampT(clock.now() + s)
      },
      stepFrame: (n) => {
        const v = video()
        if (v && item.hasVideo) stepFrames(v, clock.now(), item.fps ?? 24, n)
      },
      setIn: () => setIn(clock.now()),
      setOut: () => setOut(clock.now()),
      clearSelection: () => clear(),
      screenshot: () => {
        if (!item.hasVideo || shotBusy) return
        const t = clock.now()
        setShotBusy(true)
        api
          .screenshot(item.id, t, {
            format: shotOpts.format,
            maxWidth: maxWidthFor(shotOpts.size, shotOpts.customWidth),
            ...(shotOpts.format !== "png" ? { quality: shotOpts.quality } : {}),
          })
          .then((res) => {
            toast.success("Screenshot saved", {
              description: `${res.name} · ${res.width}×${res.height}`,
              action: {
                label: "Open",
                onClick: () => window.open(res.url, "_blank"),
              },
            })
            void invalidate.captures(item.id)
          })
          .catch((err: Error) =>
            toast.error("Screenshot failed", { description: err.message })
          )
          .finally(() => setShotBusy(false))
      },
      exportClip: () => {
        if (!selection || exporting) return
        const length = selection.end - selection.start
        if (clipOpts.format === "gif" && length > GIF_MAX_SECONDS) {
          toast.error(`GIFs are limited to ${GIF_MAX_SECONDS} seconds`, {
            description: "Pick a shorter range or export an MP4.",
          })
          return
        }
        const opts =
          clipOpts.format === "gif"
            ? {
                format: "gif" as const,
                fps: clipOpts.gifFps,
                width: clipOpts.gifWidth,
              }
            : {
                format: "mp4" as const,
                quality: clipOpts.quality,
                aspect: clipOpts.aspect,
                ...(clipOpts.aspect === "source"
                  ? { maxWidth: maxWidthFor(clipOpts.size) }
                  : {
                      shortSide: shortSideFor(clipOpts.size),
                      background: clipOpts.background,
                      focus: clipOpts.cropFocus,
                      zoom: clipOpts.cropZoom,
                      widthScale: clipOpts.cropWidth,
                    }),
              }
        const wantsAudio = clipOpts.format !== "gif" && clipOpts.audio
        api
          .clip(
            item.id,
            selection.start,
            selection.end,
            wantsAudio ? audio : -1,
            opts
          )
          .then((res) => {
            setJobId(res.jobId)
            toast(`Exporting ${exportLabel[res.job.type].toLowerCase()}`, {
              description: `${length.toFixed(1)} s from the original file`,
            })
            void invalidate.captures(item.id)
          })
          .catch((err: Error) =>
            toast.error("Could not start the export", {
              description: err.message,
            })
          )
      },
      zoomIn: () => timeline.current?.zoomIn(),
      zoomOut: () => timeline.current?.zoomOut(),
      zoomFit: () => timeline.current?.zoomFit(),
      toggleMute: () => {
        const v = video()
        if (!v) return
        v.muted = !v.muted
        try {
          localStorage.setItem(MUTED_KEY, v.muted ? "1" : "0")
        } catch {
          /* ignore */
        }
      },
      setVolume: (vol) => {
        const v = video()
        if (!v) return
        v.volume = vol
        v.muted = vol === 0
        try {
          localStorage.setItem(VOLUME_KEY, String(vol))
          localStorage.setItem(MUTED_KEY, v.muted ? "1" : "0")
        } catch {
          /* ignore */
        }
      },
      close: () => {
        videoRef.current?.pause()
        if (document.fullscreenElement) void document.exitFullscreen()
        onClose()
      },
      toggleFullscreen: () => {
        const stage = videoRef.current?.closest("[data-stage]")
        if (document.fullscreenElement) void document.exitFullscreen()
        else if (stage) void stage.requestFullscreen()
      },
    }
  }, [
    item,
    clock,
    setIn,
    setOut,
    clear,
    selection,
    exporting,
    shotBusy,
    audio,
    invalidate,
    timeline,
    shotOpts,
    clipOpts,
    onClose,
  ])

  useShortcuts(actions, true)

  const onAudioChange = (index: number) => {
    resumeRef.current = videoRef.current?.currentTime ?? 0
    void api.releaseHls(item.id, audio).catch(() => undefined)
    setAudio(index)
  }

  const notice =
    item.hdr.kind === "dovi-p5"
      ? "Dolby Vision profile 5: colours are shown without conversion"
      : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        item={item}
        audio={audio}
        onAudioChange={onAudioChange}
        onToggleSidebar={onToggleSidebar}
      />
      <VideoStage
        videoRef={videoRef}
        media={media}
        hasVideo={item.hasVideo}
        error={hls.error}
        notice={notice}
        onTogglePlay={actions.togglePlay}
        onToggleFullscreen={actions.toggleFullscreen}
      />
      <ControlBar
        item={item}
        exportOptions={exportOptions}
        media={media}
        clock={clock}
        duration={item.duration}
        hasVideo={item.hasVideo}
        selection={selection}
        busy={{ screenshot: shotBusy, export: exporting }}
        zoom={zoom}
        actions={actions}
      />
      <Timeline
        itemId={item.id}
        hasVideo={item.hasVideo}
        containerRef={containerRef}
        minimapRef={minimapRef}
        hover={hover}
        ready={zoom.level > 0}
      />
      <CapturesStrip itemId={item.id} activeJob={job.data} />
    </div>
  )
}

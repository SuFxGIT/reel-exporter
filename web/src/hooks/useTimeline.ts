import { useEffect, useRef, type RefObject } from "react"
import WaveSurfer from "wavesurfer.js"
import HoverPlugin from "wavesurfer.js/dist/plugins/hover.esm.js"
import MinimapPlugin from "wavesurfer.js/dist/plugins/minimap.esm.js"
import RegionsPlugin, {
  type Region,
} from "wavesurfer.js/dist/plugins/regions.esm.js"
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js"
import type { Selection } from "@/hooks/useSelection"
import { formatRuler, formatTime } from "@/lib/time"

export interface ZoomState {
  level: number
  fit: number
  max: number
}

export interface TimelineApi {
  zoomIn: () => void
  zoomOut: () => void
  zoomFit: () => void
}

export interface UseTimelineOptions {
  containerRef: RefObject<HTMLDivElement | null>
  minimapRef: RefObject<HTMLDivElement | null>
  video: HTMLVideoElement | null
  /** hls.js has attached the MediaSource (video.src is the blob URL). */
  attached: boolean
  duration: number
  peaks: Float32Array | null
  selection: Selection | null
  onSelectionChange: (sel: Selection | null, final: boolean) => void
  onHover: (t: number | null, x: number) => void
  onZoom: (z: ZoomState) => void
}

const MAX_PX_PER_SEC = 200
const REGION_COLOR = "rgba(245, 158, 11, 0.22)"
const MIN_REGION = 0.1

function placeholderPeaks(duration: number): Float32Array {
  return new Float32Array(Math.max(200, Math.round(duration * 4))).fill(0.04)
}

/**
 * wavesurfer.js bound to the hls.js-driven video. Created only after the MediaSource is
 * attached and always with peaks + duration, so wavesurfer never touches video.src.
 */
export function useTimeline(
  opts: UseTimelineOptions
): RefObject<TimelineApi | null> {
  const api = useRef<TimelineApi | null>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<RegionsPlugin | null>(null)
  const regionRef = useRef<Region | null>(null)
  const readyRef = useRef(false)
  const zoomRef = useRef<ZoomState>({ level: 0, fit: 0, max: MAX_PX_PER_SEC })
  const creatingRef = useRef(false)
  const latest = useRef(opts)
  latest.current = opts

  const { containerRef, minimapRef, video, attached, duration } = opts

  useEffect(() => {
    const container = containerRef.current
    const minimapEl = minimapRef.current
    if (!video || !attached || !(duration > 0) || !container || !minimapEl)
      return

    const regions = RegionsPlugin.create()
    const minimap = MinimapPlugin.create({
      container: minimapEl,
      height: 40,
      waveColor: "#3f3f46",
      progressColor: "#a1a1aa",
      cursorColor: "#fafafa",
      cursorWidth: 1,
      barWidth: 1,
      barGap: 1,
      barRadius: 1,
      overlayColor: "rgba(245, 158, 11, 0.14)",
    })
    const timeline = TimelinePlugin.create({
      height: 20,
      insertPosition: "afterend",
      formatTimeCallback: formatRuler,
      style: { color: "#71717a", fontSize: "10px" },
    })
    const hover = HoverPlugin.create({
      lineColor: "rgba(255,255,255,0.45)",
      lineWidth: 1,
      labelBackground: "#18181b",
      labelColor: "#e4e4e7",
      labelSize: 11,
      formatTimeCallback: (s) => formatTime(s),
    })
    const initialPeaks = latest.current.peaks ?? placeholderPeaks(duration)
    const ws = WaveSurfer.create({
      container,
      media: video,
      peaks: [initialPeaks],
      duration,
      height: 88,
      waveColor: "#52525b",
      progressColor: "#d4d4d8",
      cursorColor: "#fafafa",
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: false,
      fillParent: true,
      minPxPerSec: 1,
      hideScrollbar: true,
      autoScroll: true,
      autoCenter: true,
      dragToSeek: false,
      interact: true,
      plugins: [regions, timeline, hover, minimap],
    })
    wsRef.current = ws
    regionsRef.current = regions
    regionRef.current = null
    readyRef.current = false

    const fitPx = () => Math.max(0.01, container.clientWidth / duration)
    const publishZoom = () => latest.current.onZoom({ ...zoomRef.current })
    const clampZoom = (px: number) =>
      Math.min(MAX_PX_PER_SEC, Math.max(fitPx(), px))

    const zoomTo = (px: number, anchorTime?: number, anchorX?: number) => {
      if (!readyRef.current) return
      const next = clampZoom(px)
      const fit = fitPx()
      if (next <= fit + 1e-6) {
        ws.zoom(fit)
        zoomRef.current = { level: fit, fit, max: MAX_PX_PER_SEC }
        ws.setScroll(0)
      } else {
        ws.zoom(next)
        zoomRef.current = { level: next, fit, max: MAX_PX_PER_SEC }
        const t = anchorTime ?? video.currentTime
        const x = anchorX ?? container.clientWidth / 2
        ws.setScroll(t * next - x)
      }
      publishZoom()
    }

    let rafZoom = 0
    let pendingZoom: { px: number; t: number; x: number } | null = null
    const onWheel = (e: WheelEvent) => {
      if (!readyRef.current) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = container.getBoundingClientRect()
        const x = e.clientX - rect.left
        const level = zoomRef.current.level
        const t = (ws.getScroll() + x) / level
        const factor = Math.exp(-e.deltaY * 0.0025)
        pendingZoom = { px: level * factor, t, x }
        if (!rafZoom) {
          rafZoom = requestAnimationFrame(() => {
            rafZoom = 0
            if (pendingZoom)
              zoomTo(pendingZoom.px, pendingZoom.t, pendingZoom.x)
            pendingZoom = null
          })
        }
        return
      }
      if (zoomRef.current.level > zoomRef.current.fit + 1e-6) {
        e.preventDefault()
        const delta =
          (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) *
          (e.shiftKey ? 3 : 1)
        ws.setScroll(ws.getScroll() + delta)
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!readyRef.current) return
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left
      const t = Math.min(
        duration,
        Math.max(0, (ws.getScroll() + x) / zoomRef.current.level)
      )
      latest.current.onHover(t, x)
    }
    const onPointerLeave = () => latest.current.onHover(null, 0)

    const adoptRegion = (region: Region, fromDrag: boolean) => {
      for (const r of regions.getRegions()) if (r !== region) r.remove()
      regionRef.current = region
      if (fromDrag)
        latest.current.onSelectionChange(
          { start: region.start, end: region.end },
          true
        )
    }

    const subs = [
      ws.on("ready", () => {
        readyRef.current = true
        const fit = fitPx()
        ws.zoom(fit)
        zoomRef.current = { level: fit, fit, max: MAX_PX_PER_SEC }
        publishZoom()
        syncRegion(latest.current.selection)
      }),
      ws.on("zoom", (px) => {
        if (Math.abs(px - zoomRef.current.level) > 1e-6) {
          zoomRef.current = { ...zoomRef.current, level: px, fit: fitPx() }
          publishZoom()
        }
      }),
      regions.on("region-created", (region) => {
        if (creatingRef.current) return
        if (region.end - region.start < MIN_REGION) {
          region.remove()
          return
        }
        adoptRegion(region, true)
      }),
      regions.on("region-update", (region) => {
        if (region === regionRef.current)
          latest.current.onSelectionChange(
            { start: region.start, end: region.end },
            false
          )
      }),
      regions.on("region-updated", (region) => {
        if (region === regionRef.current)
          latest.current.onSelectionChange(
            { start: region.start, end: region.end },
            true
          )
      }),
      regions.on("region-removed", (region) => {
        if (region === regionRef.current) regionRef.current = null
      }),
    ]
    const disableDrag = regions.enableDragSelection({
      color: REGION_COLOR,
      drag: false,
      resize: true,
    })

    function syncRegion(sel: Selection | null) {
      if (!readyRef.current) return
      const current = regionRef.current
      if (!sel) {
        if (current) {
          regionRef.current = null
          current.remove()
        }
        return
      }
      if (current) {
        if (
          Math.abs(current.start - sel.start) > 1e-3 ||
          Math.abs(current.end - sel.end) > 1e-3
        ) {
          current.setOptions({ start: sel.start, end: sel.end })
        }
        return
      }
      creatingRef.current = true
      try {
        const region = regions.addRegion({
          start: sel.start,
          end: sel.end,
          color: REGION_COLOR,
          drag: false,
          resize: true,
          minLength: MIN_REGION,
        })
        adoptRegion(region, false)
      } finally {
        creatingRef.current = false
      }
    }

    container.addEventListener("wheel", onWheel, { passive: false })
    container.addEventListener("pointermove", onPointerMove)
    container.addEventListener("pointerleave", onPointerLeave)

    const resize = new ResizeObserver(() => {
      if (!readyRef.current) return
      const fit = fitPx()
      if (zoomRef.current.level <= zoomRef.current.fit + 1e-6) {
        ws.zoom(fit)
        zoomRef.current = { level: fit, fit, max: MAX_PX_PER_SEC }
      } else {
        zoomRef.current = { ...zoomRef.current, fit }
      }
      publishZoom()
    })
    resize.observe(container)

    api.current = {
      zoomIn: () => zoomTo(zoomRef.current.level * 1.6),
      zoomOut: () => zoomTo(zoomRef.current.level / 1.6),
      zoomFit: () => zoomTo(0),
    }
    ;(ws as WaveSurfer & { __syncRegion?: typeof syncRegion }).__syncRegion =
      syncRegion

    return () => {
      resize.disconnect()
      container.removeEventListener("wheel", onWheel)
      container.removeEventListener("pointermove", onPointerMove)
      container.removeEventListener("pointerleave", onPointerLeave)
      cancelAnimationFrame(rafZoom)
      for (const unsub of subs) unsub()
      disableDrag()
      readyRef.current = false
      api.current = null
      wsRef.current = null
      regionsRef.current = null
      regionRef.current = null
      ws.destroy()
    }
  }, [containerRef, minimapRef, video, attached, duration])

  // Real peaks arrive later (202 while the server computes them).
  const { peaks } = opts
  useEffect(() => {
    const ws = wsRef.current
    if (!ws || !peaks || !video || !readyRef.current) return
    const src = video.src
    if (!src) return
    ws.load(src, [peaks], duration).catch(() => undefined)
  }, [peaks, video, duration])

  // Keep the region in sync with the selection state (I/O keys, clear).
  const { selection } = opts
  useEffect(() => {
    const ws = wsRef.current as
      (WaveSurfer & { __syncRegion?: (sel: Selection | null) => void }) | null
    ws?.__syncRegion?.(selection)
  }, [selection])

  return api
}

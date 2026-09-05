import { useCallback, useEffect, useRef, useState } from "react"
import type { BarsResponse, ItemDetail } from "@/lib/api"
import { SHORTS_FRAMES, type ShortsAspect } from "@/lib/export-options"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export interface Focus {
  x: number
  y: number
}

export const MIN_CROP_ZOOM = 1
export const MAX_CROP_ZOOM = 3
const ZOOM_STEP = 0.1

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
export const clampZoom = (z: number) =>
  Math.min(MAX_CROP_ZOOM, Math.max(MIN_CROP_ZOOM, Math.round(z * 100) / 100))

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where the crop window sits over a frame: the largest box with the output
 * aspect that fits the picture (the frame minus detected bars), shrunk by
 * `zoom` and moved by `focus` (0..1).
 */
export function layoutWindow(
  picture: Rect,
  focus: Focus,
  zoom = 1,
  aspect = 9 / 16
): { win: Rect; axis: "x" | "y" | "both" | null } {
  const z = clampZoom(zoom)
  const wide = picture.w / picture.h > aspect
  const win: Rect = wide
    ? { x: 0, y: 0, w: (picture.h * aspect) / z, h: picture.h / z }
    : { x: 0, y: 0, w: picture.w / z, h: picture.w / aspect / z }
  const slackX = picture.w - win.w
  const slackY = picture.h - win.h
  win.x = picture.x + slackX * clamp01(focus.x)
  win.y = picture.y + slackY * clamp01(focus.y)
  const axis =
    slackX > 1 && slackY > 1
      ? "both"
      : slackX > 1
        ? "x"
        : slackY > 1
          ? "y"
          : null
  return { win, axis }
}

export function CropPicker({
  item,
  previewUrl,
  aspect,
  focus,
  onChange,
  zoom,
  onZoomChange,
  bars,
}: {
  item: ItemDetail
  previewUrl: string
  aspect: ShortsAspect
  focus: Focus
  onChange: (focus: Focus) => void
  zoom: number
  onZoomChange: (zoom: number) => void
  /** Bar detection for the range; null when trimming is off or nothing was found. */
  bars: BarsResponse | null
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(264)
  const pressed = useRef(false)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const update = () => setWidth(el.clientWidth || 264)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // React attaches wheel listeners passively, so preventDefault needs a native one.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0
      if (dir) onZoomChange(clampZoom(zoom + dir * ZOOM_STEP))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [zoom, onZoomChange])

  const v = item.video
  if (!v) return null
  const scale = width / v.displayWidth
  const height = Math.round(v.height * scale)
  const frame: Rect = { x: 0, y: 0, w: width, h: height }
  const sar = v.displayWidth / v.width
  const crop = bars?.crop
  const picture: Rect = crop
    ? {
        x: crop.x * sar * scale,
        y: crop.y * scale,
        w: crop.w * sar * scale,
        h: crop.h * scale,
      }
    : frame
  const frameOut = SHORTS_FRAMES[aspect]
  const { win, axis } = layoutWindow(
    picture,
    focus,
    zoom,
    frameOut.width / frameOut.height
  )

  const place = useCallback(
    (clientX: number, clientY: number) => {
      const el = box.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const px = clientX - r.left
      const py = clientY - r.top
      const slackX = picture.w - win.w
      const slackY = picture.h - win.h
      onChange({
        x: slackX > 1 ? clamp01((px - picture.x - win.w / 2) / slackX) : 0.5,
        y: slackY > 1 ? clamp01((py - picture.y - win.h / 2) / slackY) : 0.5,
      })
    },
    [onChange, picture.x, picture.y, picture.w, picture.h, win.w, win.h]
  )

  const nudge = (dx: number, dy: number) =>
    onChange({ x: clamp01(focus.x + dx), y: clamp01(focus.y + dy) })

  const atDefault = focus.x === 0.5 && focus.y === 0.5 && zoom === 1
  const shade = "bg-black/70 absolute"
  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label="Crop position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((axis === "y" ? focus.y : focus.x) * 100)}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          pressed.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          place(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => {
          if (pressed.current) place(e.clientX, e.clientY)
        }}
        onPointerUp={() => (pressed.current = false)}
        onPointerCancel={() => (pressed.current = false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") nudge(-0.02, 0)
          else if (e.key === "ArrowRight") nudge(0.02, 0)
          else if (e.key === "ArrowUp") nudge(0, -0.02)
          else if (e.key === "ArrowDown") nudge(0, 0.02)
          else if (e.key === "+" || e.key === "=")
            onZoomChange(clampZoom(zoom + ZOOM_STEP))
          else if (e.key === "-") onZoomChange(clampZoom(zoom - ZOOM_STEP))
          else return
          e.preventDefault()
        }}
        className={cn(
          "focus-visible:ring-ring relative w-full touch-none overflow-hidden rounded-md bg-black outline-none select-none focus-visible:ring-2",
          axis === "both"
            ? "cursor-move"
            : axis === "x"
              ? "cursor-ew-resize"
              : axis === "y"
                ? "cursor-ns-resize"
                : "cursor-default"
        )}
        style={{ height }}
      >
        <img
          src={previewUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-fill"
        />
        {crop && (
          <>
            <div
              className={shade}
              style={{ left: 0, top: 0, width, height: picture.y }}
            />
            <div
              className={shade}
              style={{
                left: 0,
                top: picture.y + picture.h,
                width,
                height: Math.max(0, height - picture.y - picture.h),
              }}
            />
            <div
              className={shade}
              style={{
                left: 0,
                top: picture.y,
                width: picture.x,
                height: picture.h,
              }}
            />
            <div
              className={shade}
              style={{
                left: picture.x + picture.w,
                top: picture.y,
                width: Math.max(0, width - picture.x - picture.w),
                height: picture.h,
              }}
            />
          </>
        )}
        <div
          className="border-primary pointer-events-none absolute rounded-sm border-2"
          style={{
            left: win.x,
            top: win.y,
            width: win.w,
            height: win.h,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
          }}
        />
      </div>
      <div className="text-muted-foreground flex items-center justify-between text-[11px]">
        <span>
          {axis === null && zoom === 1
            ? `The picture already fits ${aspect}. Zoom to crop tighter.`
            : crop
              ? "Drag to move, scroll to zoom. Black bars are left out."
              : "Drag to move, scroll to zoom"}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            onChange({ x: 0.5, y: 0.5 })
            onZoomChange(1)
          }}
          disabled={atDefault}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}

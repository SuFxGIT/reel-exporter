import { useCallback, useEffect, useRef, useState } from "react"
import type { BarsResponse, ItemDetail } from "@/lib/api"
import {
  CROP_WIDTH_RANGE,
  CROP_ZOOM_RANGE,
  type FrameBackground,
} from "@/lib/export-options"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export interface Focus {
  x: number
  y: number
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
export const clampZoom = (z: number) =>
  Math.min(
    CROP_ZOOM_RANGE.max,
    Math.max(CROP_ZOOM_RANGE.min, Math.round(z * 100) / 100)
  )
export const clampWidth = (k: number) =>
  Math.min(
    CROP_WIDTH_RANGE.max,
    Math.max(CROP_WIDTH_RANGE.min, Math.round(k * 100) / 100)
  )
/** Finer steps below 1× where a tenth is a big jump. */
const zoomStep = (z: number, dir: 1 | -1) =>
  clampZoom(z + dir * (z + (dir < 0 ? -0.001 : 0.001) < 1 ? 0.05 : 0.1))

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Preview stage height in pixels; fixed so the dialog never resizes. */
const STAGE_HEIGHT = 240

/**
 * Where the window sits over a picture: the largest box with the output aspect
 * that fits the picture (the frame minus detected bars, after the width squeeze),
 * divided by `zoom` and moved by `focus` (0..1). Below 1× the window is bigger
 * than the picture, and focus places the picture inside it instead.
 */
export function layoutWindow(
  picture: Rect,
  focus: Focus,
  zoom = 1,
  ratio = 9 / 16
): { win: Rect; movable: boolean } {
  const z = clampZoom(zoom)
  const wide = picture.w / picture.h > ratio
  const win: Rect = wide
    ? { x: 0, y: 0, w: (picture.h * ratio) / z, h: picture.h / z }
    : { x: 0, y: 0, w: picture.w / z, h: picture.w / ratio / z }
  const slackX = picture.w - win.w
  const slackY = picture.h - win.h
  win.x = picture.x + slackX * clamp01(focus.x)
  win.y = picture.y + slackY * clamp01(focus.y)
  return { win, movable: Math.abs(slackX) > 1 || Math.abs(slackY) > 1 }
}

/** The zoom at which the whole picture sits inside the window. */
export function fitZoom(picture: Rect, ratio: number): number {
  const wide = picture.w / picture.h > ratio
  return clampZoom(
    wide ? (picture.h * ratio) / picture.w : picture.w / ratio / picture.h
  )
}

export function CropPicker({
  item,
  previewUrl,
  ratio,
  focus,
  zoom,
  widthScale,
  background,
  bars,
  onChange,
}: {
  item: ItemDetail
  previewUrl: string
  /** Output aspect as width / height. */
  ratio: number
  focus: Focus
  zoom: number
  /** Horizontal squeeze or stretch; 1 is the real width. */
  widthScale: number
  background: FrameBackground
  /** Bar detection for the range; null when nothing was found. */
  bars: BarsResponse | null
  onChange: (patch: {
    focus?: Focus
    zoom?: number
    widthScale?: number
  }) => void
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
      if (dir) onChange({ zoom: zoomStep(zoom, dir) })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [zoom, onChange])

  const v = item.video
  if (!v) return null

  // Everything below is in squeezed source pixels: x is multiplied by the width scale.
  const k = clampWidth(widthScale)
  const sar = v.displayWidth / v.width
  const full: Rect = { x: 0, y: 0, w: v.displayWidth * k, h: v.height }
  const crop = bars?.crop
  const picture: Rect = crop
    ? { x: crop.x * sar * k, y: crop.y, w: crop.w * sar * k, h: crop.h }
    : full
  const { win, movable } = layoutWindow(picture, focus, zoom, ratio)
  // The canvas shows the picture and the window, whichever is bigger.
  const bound: Rect = {
    x: Math.min(full.x, win.x),
    y: Math.min(full.y, win.y),
    w: 0,
    h: 0,
  }
  bound.w = Math.max(full.x + full.w, win.x + win.w) - bound.x
  bound.h = Math.max(full.y + full.h, win.y + win.h) - bound.y
  // The stage has a fixed size; the drawing is fitted and centred inside it so
  // zooming out never changes the height of the dialog.
  const height = STAGE_HEIGHT
  const s = Math.min(width / bound.w, height / bound.h)
  const ox = (width - bound.w * s) / 2
  const oy = (height - bound.h * s) / 2
  const px = (r: Rect) => ({
    left: ox + (r.x - bound.x) * s,
    top: oy + (r.y - bound.y) * s,
    width: r.w * s,
    height: r.h * s,
  })

  const place = useCallback(
    (clientX: number, clientY: number) => {
      const el = box.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const x = (clientX - r.left - ox) / s + bound.x
      const y = (clientY - r.top - oy) / s + bound.y
      const slackX = picture.w - win.w
      const slackY = picture.h - win.h
      onChange({
        focus: {
          x:
            Math.abs(slackX) > 1
              ? clamp01((x - picture.x - win.w / 2) / slackX)
              : 0.5,
          y:
            Math.abs(slackY) > 1
              ? clamp01((y - picture.y - win.h / 2) / slackY)
              : 0.5,
        },
      })
    },
    [
      onChange,
      s,
      ox,
      oy,
      bound.x,
      bound.y,
      picture.x,
      picture.y,
      picture.w,
      picture.h,
      win.w,
      win.h,
    ]
  )

  const nudge = (dx: number, dy: number) =>
    onChange({ focus: { x: clamp01(focus.x + dx), y: clamp01(focus.y + dy) } })

  const atDefault =
    focus.x === 0.5 && focus.y === 0.5 && zoom === 1 && widthScale === 1
  const fitted = fitZoom(picture, ratio)
  const shade = "bg-black/70 absolute"
  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label="Picture position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(focus.x * 100)}
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
            onChange({ zoom: zoomStep(zoom, 1) })
          else if (e.key === "-") onChange({ zoom: zoomStep(zoom, -1) })
          else return
          e.preventDefault()
        }}
        className={cn(
          "focus-visible:ring-ring relative w-full touch-none overflow-hidden rounded-md bg-black outline-none select-none focus-visible:ring-2",
          movable ? "cursor-move" : "cursor-default"
        )}
        style={{ height }}
      >
        {background === "blur" && (
          <div
            className="pointer-events-none absolute overflow-hidden"
            style={px(win)}
          >
            <img
              src={previewUrl}
              alt=""
              draggable={false}
              className="h-full w-full object-cover"
              style={{ filter: "blur(10px)", transform: "scale(1.15)" }}
            />
          </div>
        )}
        <img
          src={previewUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute object-fill"
          style={px(full)}
        />
        {crop && (
          <>
            <div
              className={shade}
              style={px({ x: full.x, y: full.y, w: full.w, h: picture.y })}
            />
            <div
              className={shade}
              style={px({
                x: full.x,
                y: picture.y + picture.h,
                w: full.w,
                h: Math.max(0, full.h - picture.y - picture.h),
              })}
            />
            <div
              className={shade}
              style={px({
                x: full.x,
                y: picture.y,
                w: picture.x,
                h: picture.h,
              })}
            />
            <div
              className={shade}
              style={px({
                x: picture.x + picture.w,
                y: picture.y,
                w: Math.max(0, full.w - picture.x - picture.w),
                h: picture.h,
              })}
            />
          </>
        )}
        <div
          className="border-primary pointer-events-none absolute rounded-sm border-2"
          style={{
            ...px(win),
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
          }}
        />
      </div>
      <div className="text-muted-foreground flex items-center justify-between gap-2 text-[11px]">
        <span>
          {crop
            ? "Drag to move, scroll to zoom. Black bars are left out."
            : "Drag to move, scroll to zoom"}
        </span>
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              onChange({ zoom: fitted, focus: { x: 0.5, y: 0.5 } })
            }
            disabled={zoom === fitted && focus.x === 0.5 && focus.y === 0.5}
          >
            Fit
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              onChange({ focus: { x: 0.5, y: 0.5 }, zoom: 1, widthScale: 1 })
            }
            disabled={atDefault}
          >
            Reset
          </Button>
        </div>
      </div>
    </div>
  )
}

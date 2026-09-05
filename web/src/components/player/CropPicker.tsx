import { useCallback, useEffect, useRef, useState } from "react"
import type { BarsResponse, ItemDetail } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export interface Focus {
  x: number
  y: number
}

const OUT_ASPECT = 9 / 16
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where the 9:16 window sits over a frame: the largest 9:16 box that fits the
 * picture (the frame minus detected bars), moved by `focus` (0..1).
 */
export function layoutWindow(
  picture: Rect,
  focus: Focus
): { win: Rect; axis: "x" | "y" | null } {
  const wide = picture.w / picture.h > OUT_ASPECT
  const win: Rect = wide
    ? { x: 0, y: picture.y, w: picture.h * OUT_ASPECT, h: picture.h }
    : { x: picture.x, y: 0, w: picture.w, h: picture.w / OUT_ASPECT }
  const slackX = picture.w - win.w
  const slackY = picture.h - win.h
  win.x = picture.x + slackX * clamp01(focus.x)
  win.y = picture.y + slackY * clamp01(focus.y)
  return { win, axis: slackX > 1 ? "x" : slackY > 1 ? "y" : null }
}

export function CropPicker({
  item,
  previewUrl,
  focus,
  onChange,
  bars,
}: {
  item: ItemDetail
  previewUrl: string
  focus: Focus
  onChange: (focus: Focus) => void
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
  const { win, axis } = layoutWindow(picture, focus)

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
          else return
          e.preventDefault()
        }}
        className={cn(
          "focus-visible:ring-ring relative w-full touch-none overflow-hidden rounded-md bg-black outline-none select-none focus-visible:ring-2",
          axis === "x"
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
          {axis === null
            ? "The picture already fits 9:16"
            : crop
              ? "Drag to choose the crop. Black bars are left out."
              : "Drag to choose the crop"}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onChange({ x: 0.5, y: 0.5 })}
          disabled={focus.x === 0.5 && focus.y === 0.5}
        >
          Center
        </Button>
      </div>
    </div>
  )
}

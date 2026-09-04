import { useCallback, useEffect, useRef, useState } from "react"

const DRAG_THRESHOLD = 6

interface DragState {
  /** Index of the tile being dragged. */
  from: number
  /** Index the tile lands at once removed from the row (0..n-1). */
  to: number
  /** Horizontal offset of the dragged tile from its resting spot, in px. */
  dx: number
}

/**
 * Pointer-driven horizontal reordering for a row of tiles. Register each tile
 * with `bind(index)`; a drag starts once the pointer moves a few pixels, so a
 * plain click still reaches the tile. `onMove(from, to)` fires on drop.
 */
export function useReorder(
  count: number,
  onMove: (from: number, to: number) => void
) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const tiles = useRef<Array<HTMLElement | null>>([])
  const press = useRef<{
    index: number
    x: number
    y: number
    pointerId: number
    el: HTMLElement
    active: boolean
  } | null>(null)
  const suppressClick = useRef(false)

  // Index in the row without the dragged tile: how many other tiles have
  // their midpoint left of the pointer.
  const insertionIndex = useCallback(
    (clientX: number, from: number): number => {
      let to = 0
      for (let i = 0; i < count; i++) {
        if (i === from) continue
        const el = tiles.current[i]
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (clientX > r.left + r.width / 2) to++
      }
      return to
    },
    [count]
  )

  const end = useCallback(
    (commit: boolean) => {
      const p = press.current
      press.current = null
      if (!p) return
      if (p.active) {
        p.el.releasePointerCapture?.(p.pointerId)
        suppressClick.current = true
        setTimeout(() => (suppressClick.current = false), 0)
      }
      setDrag((d) => {
        if (commit && d && d.to !== d.from) onMove(d.from, d.to)
        return null
      })
    },
    [onMove]
  )

  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [drag, end])

  const bind = (index: number) => ({
    ref: (el: HTMLElement | null) => {
      tiles.current[index] = el
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || e.pointerType === "touch") return
      press.current = {
        index,
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        el: e.currentTarget,
        active: false,
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const p = press.current
      if (!p || p.index !== index) return
      const dx = e.clientX - p.x
      if (!p.active) {
        if (Math.hypot(dx, e.clientY - p.y) < DRAG_THRESHOLD) return
        p.active = true
        p.el.setPointerCapture(e.pointerId)
      }
      setDrag({ from: index, to: insertionIndex(e.clientX, index), dx })
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onClickCapture: (e: React.MouseEvent) => {
      if (suppressClick.current) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
  })

  return { drag, bind }
}

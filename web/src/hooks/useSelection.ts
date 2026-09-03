import { useCallback, useState } from "react"

export interface Selection {
  start: number
  end: number
}

const MIN_LENGTH = 0.1

export function useSelection(duration: number) {
  const [selection, setSelectionState] = useState<Selection | null>(null)

  const clamp = useCallback(
    (t: number) =>
      Math.min(
        Math.max(0, t),
        duration > 0 ? duration : Number.MAX_SAFE_INTEGER
      ),
    [duration]
  )

  const setSelection = useCallback(
    (sel: Selection | null) => {
      if (!sel) {
        setSelectionState(null)
        return
      }
      const start = clamp(Math.min(sel.start, sel.end))
      const end = clamp(Math.max(sel.start, sel.end))
      setSelectionState(end - start >= MIN_LENGTH ? { start, end } : null)
    },
    [clamp]
  )

  /** Sets the in point at t; keeps the out point when it is still after t. */
  const setIn = useCallback(
    (t: number) => {
      setSelectionState((cur) => {
        const start = clamp(t)
        const end =
          cur && cur.end > start + MIN_LENGTH
            ? cur.end
            : clamp(
                start + Math.max(MIN_LENGTH, Math.min(10, duration - start))
              )
        return end - start >= MIN_LENGTH ? { start, end } : cur
      })
    },
    [clamp, duration]
  )

  /** Sets the out point at t; keeps the in point when it is still before t. */
  const setOut = useCallback(
    (t: number) => {
      setSelectionState((cur) => {
        const end = clamp(t)
        const start =
          cur && cur.start < end - MIN_LENGTH
            ? cur.start
            : Math.max(0, end - 10)
        return end - start >= MIN_LENGTH ? { start, end } : cur
      })
    },
    [clamp]
  )

  const clear = useCallback(() => setSelectionState(null), [])

  return { selection, setSelection, setIn, setOut, clear }
}

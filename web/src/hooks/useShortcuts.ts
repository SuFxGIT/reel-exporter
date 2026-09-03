import { useEffect } from "react"
import type { PlayerActions } from "@/components/player/ControlBar"

const IGNORE =
  'input, textarea, select, [contenteditable="true"], [role="listbox"], [role="dialog"], [role="menu"], [role="combobox"]'

export function useShortcuts(actions: PlayerActions, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest(IGNORE)) return
      let handled = true
      switch (e.key) {
        case " ":
          actions.togglePlay()
          break
        case "ArrowLeft":
          actions.seekBy(e.shiftKey ? -1 : -5)
          break
        case "ArrowRight":
          actions.seekBy(e.shiftKey ? 1 : 5)
          break
        case ",":
          actions.stepFrame(-1)
          break
        case ".":
          actions.stepFrame(1)
          break
        case "i":
        case "I":
          actions.setIn()
          break
        case "o":
        case "O":
          actions.setOut()
          break
        case "Backspace":
          actions.clearSelection()
          break
        case "Escape":
          if (document.fullscreenElement) handled = false
          else actions.clearSelection()
          break
        case "s":
        case "S":
          actions.screenshot()
          break
        case "e":
        case "E":
          actions.exportClip()
          break
        case "+":
        case "=":
          actions.zoomIn()
          break
        case "-":
        case "_":
          actions.zoomOut()
          break
        case "0":
          actions.zoomFit()
          break
        case "f":
        case "F":
          actions.toggleFullscreen()
          break
        case "m":
        case "M":
          actions.toggleMute()
          break
        default:
          handled = false
      }
      if (handled) e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [actions, enabled])
}

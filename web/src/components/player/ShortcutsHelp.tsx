import { CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const rows: Array<[string, string]> = [
  ["Space", "Play or pause"],
  ["← →", "Back or forward 5 s"],
  ["Shift + ← →", "Back or forward 1 s"],
  [", .", "Previous or next frame"],
  ["I O", "Set in or out point"],
  ["Backspace", "Clear selection"],
  ["S", "Save screenshot"],
  ["E", "Export the selection (Video or GIF)"],
  ["+ - 0", "Zoom in, out, fit"],
  ["Ctrl + wheel", "Zoom at pointer"],
  ["Wheel", "Scroll timeline"],
  ["F", "Fullscreen"],
  ["M", "Mute"],
  ["/", "Search library"],
]

export function ShortcutsHelp() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Keyboard shortcuts"
          />
        }
      >
        <CircleHelp />
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-none p-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {rows.map(([k, d]) => (
            <div key={k} className="contents">
              <kbd className="border-background/30 bg-background/10 rounded border px-1.5 font-mono text-[11px] tabular-nums">
                {k}
              </kbd>
              <span>{d}</span>
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

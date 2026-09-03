import {
  ChevronFirst,
  ChevronLast,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import type { MediaState } from "@/hooks/useMediaState"
import type { PlaybackClock } from "@/hooks/usePlaybackClock"
import type { Selection } from "@/hooks/useSelection"
import type { ItemDetail } from "@/lib/api"
import type { useExportOptions } from "@/lib/export-options"
import { formatTime } from "@/lib/time"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ExportButton, ScreenshotButton } from "./ExportOptions"
import { TimeReadout } from "./TimeReadout"

export interface PlayerActions {
  togglePlay: () => void
  seekBy: (seconds: number) => void
  stepFrame: (n: number) => void
  setIn: () => void
  setOut: () => void
  clearSelection: () => void
  screenshot: () => void
  exportClip: () => void
  zoomIn: () => void
  zoomOut: () => void
  zoomFit: () => void
  toggleMute: () => void
  setVolume: (v: number) => void
  toggleFullscreen: () => void
}

interface Props {
  item: ItemDetail
  exportOptions: ReturnType<typeof useExportOptions>
  media: MediaState
  clock: PlaybackClock
  duration: number
  hasVideo: boolean
  selection: Selection | null
  busy: { screenshot: boolean; export: boolean }
  zoom: { level: number; fit: number; max: number }
  actions: PlayerActions
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
  className,
  active,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  className?: string
  active?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              onClick()
              ;(e.currentTarget as HTMLElement).blur()
            }}
            disabled={disabled}
            aria-label={label}
            className={cn(className, active && "bg-primary/15 text-primary")}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ControlBar({
  item,
  exportOptions,
  media,
  clock,
  duration,
  hasVideo,
  selection,
  busy,
  zoom,
  actions,
}: Props) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-t border-b px-1.5">
      <IconButton
        label={media.paused ? "Play (Space)" : "Pause (Space)"}
        onClick={actions.togglePlay}
      >
        {media.paused ? <Play /> : <Pause />}
      </IconButton>
      <IconButton label="Back 5 s (←)" onClick={() => actions.seekBy(-5)}>
        <RotateCcw />
      </IconButton>
      <IconButton label="Forward 5 s (→)" onClick={() => actions.seekBy(5)}>
        <RotateCw />
      </IconButton>
      <IconButton
        label="Previous frame (,)"
        onClick={() => actions.stepFrame(-1)}
        disabled={!hasVideo}
      >
        <ChevronFirst />
      </IconButton>
      <IconButton
        label="Next frame (.)"
        onClick={() => actions.stepFrame(1)}
        disabled={!hasVideo}
      >
        <ChevronLast />
      </IconButton>

      <div className="mx-2">
        <TimeReadout clock={clock} duration={duration} />
      </div>

      <div className="hidden items-center gap-1 sm:flex">
        <IconButton
          label={media.muted ? "Unmute (M)" : "Mute (M)"}
          onClick={actions.toggleMute}
        >
          {media.muted || media.volume === 0 ? <VolumeX /> : <Volume2 />}
        </IconButton>
        <Slider
          className="w-20"
          min={0}
          max={100}
          value={media.muted ? 0 : Math.round(media.volume * 100)}
          onValueChange={(v) =>
            actions.setVolume((Array.isArray(v) ? v[0]! : v) / 100)
          }
          aria-label="Volume"
        />
      </div>

      <div className="mx-auto" />

      <ScreenshotButton
        item={item}
        options={exportOptions.screenshot}
        onChange={exportOptions.setScreenshot}
        busy={busy.screenshot}
        onCapture={actions.screenshot}
      />

      <div className="bg-border mx-1 h-5 w-px" />

      <IconButton
        label="Set in point (I)"
        onClick={actions.setIn}
        active={selection !== null}
      >
        <span className="text-[11px] font-semibold">IN</span>
      </IconButton>
      <IconButton
        label="Set out point (O)"
        onClick={actions.setOut}
        active={selection !== null}
      >
        <span className="text-[11px] font-semibold">OUT</span>
      </IconButton>
      {selection && (
        <>
          <span className="tnum text-muted-foreground hidden text-[11px] lg:inline">
            {formatTime(selection.start)} → {formatTime(selection.end)}
          </span>
          <IconButton
            label="Clear selection (Backspace)"
            onClick={actions.clearSelection}
          >
            <X />
          </IconButton>
        </>
      )}
      <div className="ml-1">
        <ExportButton
          item={item}
          options={exportOptions.clip}
          onChange={exportOptions.setClip}
          selection={selection}
          busy={busy.export}
          onExport={actions.exportClip}
        />
      </div>

      <div className="bg-border mx-1 h-5 w-px" />

      <IconButton
        label="Zoom out (-)"
        onClick={actions.zoomOut}
        disabled={zoom.level <= zoom.fit + 0.001}
      >
        <ZoomOut />
      </IconButton>
      <IconButton
        label="Zoom in (+)"
        onClick={actions.zoomIn}
        disabled={zoom.level >= zoom.max - 0.001}
      >
        <ZoomIn />
      </IconButton>
      <IconButton
        label="Fit timeline (0)"
        onClick={actions.zoomFit}
        disabled={zoom.level <= zoom.fit + 0.001}
      >
        <span className="text-[11px] font-semibold">FIT</span>
      </IconButton>
      <IconButton
        label="Fullscreen (F)"
        onClick={actions.toggleFullscreen}
        className="hidden sm:inline-flex"
      >
        <Maximize2 />
      </IconButton>
    </div>
  )
}

import { Camera, ChevronDown, Loader2, Scissors } from "lucide-react"
import type { ItemDetail } from "@/lib/api"
import {
  maxWidthFor,
  type ClipOptions,
  type ScreenshotOptions,
  type SizePreset,
} from "@/lib/export-options"
import type { Selection } from "@/hooks/useSelection"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Output size for a width limit, keeping the source aspect and even dimensions. */
export function outputSize(
  item: ItemDetail,
  maxWidth: number | undefined
): { width: number; height: number } | null {
  const v = item.video
  if (!v) return null
  if (!maxWidth || maxWidth >= v.displayWidth)
    return { width: v.displayWidth, height: v.height }
  const h = Math.round((v.height * maxWidth) / v.displayWidth)
  return { width: maxWidth, height: h - (h % 2) }
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  )
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<[T, string]>
  onChange: (v: T) => void
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(v) => {
        const next = (v as T[])[0]
        if (next) onChange(next)
      }}
      variant="outline"
      size="sm"
      spacing={0}
      className="-space-x-px"
    >
      {options.map(([v, label]) => (
        <ToggleGroupItem
          key={v}
          value={v}
          aria-label={label}
          className="data-[state=on]:bg-primary/15 data-[state=on]:text-primary px-2 text-xs"
        >
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function SplitButton({
  label,
  tooltip,
  icon,
  busy,
  disabled,
  onPrimary,
  primaryVariant,
  optionsLabel,
  children,
}: {
  label: string
  tooltip: string
  icon: React.ReactNode
  busy: boolean
  disabled: boolean
  onPrimary: () => void
  primaryVariant: "default" | "secondary"
  optionsLabel: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-stretch">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={primaryVariant}
              size="sm"
              onClick={(e) => {
                onPrimary()
                ;(e.currentTarget as HTMLElement).blur()
              }}
              disabled={disabled}
              className="gap-1.5 rounded-r-none"
            />
          }
        >
          {busy ? <Loader2 className="animate-spin" /> : icon}
          <span>{label}</span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant={primaryVariant}
              size="sm"
              aria-label={optionsLabel}
              className="w-6 rounded-l-none border-l border-black/20 px-0"
            />
          }
        >
          <ChevronDown className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent>{children}</PopoverContent>
      </Popover>
    </div>
  )
}

const SIZE_OPTIONS: Array<[SizePreset, string]> = [
  ["source", "Source"],
  ["1080", "1080p"],
  ["720", "720p"],
]

export function ScreenshotButton({
  item,
  options,
  onChange,
  busy,
  onCapture,
}: {
  item: ItemDetail
  options: ScreenshotOptions
  onChange: (patch: Partial<ScreenshotOptions>) => void
  busy: boolean
  onCapture: () => void
}) {
  const size = outputSize(item, maxWidthFor(options.size, options.customWidth))
  return (
    <SplitButton
      label="Screenshot"
      tooltip="Save this frame (S)"
      icon={<Camera />}
      busy={busy}
      disabled={!item.hasVideo || busy}
      onPrimary={onCapture}
      primaryVariant="secondary"
      optionsLabel="Screenshot options"
    >
      <div className="flex flex-col gap-3">
        <Field label="Format">
          <Choice
            value={options.format}
            options={[
              ["png", "PNG"],
              ["jpeg", "JPEG"],
            ]}
            onChange={(format) => onChange({ format })}
          />
        </Field>
        <Field label="Size">
          <Choice
            value={options.size}
            options={[...SIZE_OPTIONS, ["custom", "Width"]]}
            onChange={(size) => onChange({ size })}
          />
        </Field>
        {options.size === "custom" && (
          <Field label="Max width">
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={160}
                max={7680}
                step={16}
                value={options.customWidth}
                onChange={(e) =>
                  onChange({ customWidth: Number(e.target.value) || 0 })
                }
                className="h-7 w-24 text-xs tabular-nums"
                aria-label="Maximum width in pixels"
              />
              <span className="text-muted-foreground text-xs">px</span>
            </div>
          </Field>
        )}
        <p className="tnum text-muted-foreground text-xs">
          {options.format.toUpperCase()}
          {size ? ` · ${size.width}×${size.height}` : ""}
          {item.hdr.tonemap ? " · tone-mapped to SDR" : ""}
        </p>
        <Button
          size="sm"
          onClick={onCapture}
          disabled={!item.hasVideo || busy}
          className="gap-1.5"
        >
          {busy ? <Loader2 className="animate-spin" /> : <Camera />} Save
          screenshot
        </Button>
      </div>
    </SplitButton>
  )
}

export function ExportButton({
  item,
  options,
  onChange,
  selection,
  busy,
  onExport,
}: {
  item: ItemDetail
  options: ClipOptions
  onChange: (patch: Partial<ClipOptions>) => void
  selection: Selection | null
  busy: boolean
  onExport: () => void
}) {
  const size = outputSize(item, maxWidthFor(options.size))
  const length = selection ? selection.end - selection.start : 0
  const lengthLabel =
    length >= 60
      ? `${Math.floor(length / 60)}m ${Math.round(length % 60)}s`
      : `${length.toFixed(1)}s`
  const hasAudio = item.audio.length > 0
  return (
    <SplitButton
      label={selection ? `Export ${lengthLabel}` : "Export"}
      tooltip={
        selection
          ? "Export the selection as an MP4 (E)"
          : "Set in and out points first"
      }
      icon={<Scissors />}
      busy={busy}
      disabled={!selection || busy}
      onPrimary={onExport}
      primaryVariant="default"
      optionsLabel="Export options"
    >
      <div className="flex flex-col gap-3">
        <Field label="Size">
          <Choice
            value={options.size}
            options={SIZE_OPTIONS}
            onChange={(size) => onChange({ size: size as ClipOptions["size"] })}
          />
        </Field>
        <Field label="Quality">
          <Choice
            value={options.quality}
            options={[
              ["high", "High"],
              ["balanced", "Balanced"],
              ["small", "Small"],
            ]}
            onChange={(quality) => onChange({ quality })}
          />
        </Field>
        <Field label="Audio">
          <Switch
            size="sm"
            checked={hasAudio && options.audio}
            disabled={!hasAudio}
            onCheckedChange={(checked) => onChange({ audio: checked })}
            aria-label="Include audio"
          />
        </Field>
        <p className="tnum text-muted-foreground text-xs">
          MP4 H.264{size ? ` · ${size.width}×${size.height}` : ""} · CRF{" "}
          {options.quality === "high"
            ? 18
            : options.quality === "small"
              ? 24
              : 20}
          {hasAudio && options.audio ? " · AAC stereo" : " · no audio"}
          {item.hdr.tonemap ? " · SDR" : ""}
        </p>
        <Button
          size="sm"
          onClick={onExport}
          disabled={!selection || busy}
          className="gap-1.5"
        >
          {busy ? <Loader2 className="animate-spin" /> : <Scissors />}{" "}
          {selection ? `Export ${lengthLabel}` : "Set in and out first"}
        </Button>
      </div>
    </SplitButton>
  )
}

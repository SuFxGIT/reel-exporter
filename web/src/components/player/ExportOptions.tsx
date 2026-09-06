import { Camera, Loader2, Scissors, SlidersHorizontal } from "lucide-react"
import { frameUrl, type BarsResponse, type ItemDetail } from "@/lib/api"
import { useBars } from "@/lib/queries"
import { CropPicker, clampWidth, clampZoom } from "./CropPicker"
import {
  GIF_MAX_SECONDS,
  maxWidthFor,
  type ClipOptions,
  type GifFps,
  type GifWidth,
  type ScreenshotOptions,
  type SizePreset,
  FRAME_RATIOS,
  shortSideFor,
  type ExportAspect,
  type FrameAspect,
  CROP_WIDTH_RANGE,
  CROP_ZOOM_RANGE,
} from "@/lib/export-options"
import type { Selection } from "@/hooks/useSelection"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Slider } from "@/components/ui/slider"
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

const even = (n: number) => Math.round(n / 2) * 2

/**
 * Output size of a framed export. Mirrors the server: a short side scales the
 * frame, otherwise the frame is native (the largest box of the aspect inside the
 * squeezed picture, divided by the zoom when zooming in).
 */
export function frameSize(
  item: ItemDetail,
  aspect: FrameAspect,
  shortSide: number | undefined,
  zoom: number,
  widthScale: number,
  crop: BarsResponse["crop"]
): { width: number; height: number } | null {
  const v = item.video
  if (!v) return null
  const ratio = FRAME_RATIOS[aspect]
  if (shortSide)
    return ratio < 1
      ? { width: shortSide, height: even(shortSide / ratio) }
      : { width: even(shortSide * ratio), height: shortSide }
  const sar = v.displayWidth / v.width
  const pw = (crop ? crop.w * sar : v.displayWidth) * widthScale
  const ph = crop ? crop.h : v.height
  const wide = pw / ph > ratio
  const z = Math.max(1, zoom)
  const w = (wide ? ph * ratio : pw) / z
  const h = (wide ? ph : pw / ratio) / z
  return { width: Math.floor(w / 2) * 2, height: Math.floor(h / 2) * 2 }
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
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
  dialogClassName,
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
  /** Sizes the options dialog; give it a fixed size so it never jumps while editing. */
  dialogClassName: string
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
      <Dialog>
        <DialogTrigger
          render={
            <Button
              variant={primaryVariant}
              size="sm"
              aria-label={optionsLabel}
              className="w-6 rounded-l-none border-l border-black/20 px-0"
            />
          }
        >
          <SlidersHorizontal className="size-3.5" />
        </DialogTrigger>
        <DialogContent
          className={cn(
            "grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden",
            dialogClassName
          )}
        >
          <DialogHeader>
            <DialogTitle>{optionsLabel}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
            {children}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function formatLabel(o: ScreenshotOptions): string {
  if (o.format === "png") return "PNG"
  if (o.format === "jpeg") return `JPEG ${o.quality}`
  return o.quality >= 100 ? "WebP lossless" : `WebP ${o.quality}`
}

const ASPECT_OPTIONS: Array<[ExportAspect, string]> = [
  ["source", "Source"],
  ["9:16", "9:16"],
  ["4:5", "4:5"],
  ["1:1", "1:1"],
  ["4:3", "4:3"],
  ["16:9", "16:9"],
]
const GIF_WIDTHS: Array<[string, string]> = [
  ["320", "320"],
  ["480", "480"],
  ["640", "640"],
]
const GIF_FPS: Array<[string, string]> = [
  ["10", "10"],
  ["15", "15"],
  ["20", "20"],
]

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
      dialogClassName="w-[360px] sm:max-w-[360px]"
    >
      <div className="flex flex-col gap-3">
        <Field label="Format">
          <Choice
            value={options.format}
            options={[
              ["png", "PNG"],
              ["jpeg", "JPEG"],
              ["webp", "WebP"],
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
        {options.format !== "png" && (
          <Field label="Quality">
            <div className="flex items-center gap-2">
              <Slider
                className="w-28"
                min={50}
                max={100}
                step={1}
                value={options.quality}
                onValueChange={(v) =>
                  onChange({ quality: Array.isArray(v) ? v[0]! : v })
                }
                aria-label="Image quality"
              />
              <span className="tnum text-muted-foreground w-7 text-right text-xs">
                {options.quality}
              </span>
            </div>
          </Field>
        )}
        <p className="tnum text-muted-foreground text-xs">
          {formatLabel(options)}
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
  const { format } = options
  const framed = format === "mp4" && options.aspect !== "source"
  const rangeStart = selection?.start ?? 0
  const rangeEnd = selection?.end ?? rangeStart + 5
  const bars = useBars(item.id, rangeStart, rangeEnd, framed)
  const crop = (bars.data as BarsResponse | undefined)?.crop ?? null
  const shortSide = shortSideFor(options.size)
  const size =
    format === "gif"
      ? outputSize(item, options.gifWidth)
      : framed
        ? frameSize(
            item,
            options.aspect as FrameAspect,
            shortSide,
            options.cropZoom,
            options.cropWidth,
            crop
          )
        : outputSize(item, maxWidthFor(options.size))
  const length = selection ? selection.end - selection.start : 0
  const lengthLabel =
    length >= 60
      ? `${Math.floor(length / 60)}m ${Math.round(length % 60)}s`
      : `${length.toFixed(1)}s`
  const hasAudio = item.audio.length > 0
  const withAudio = format !== "gif" && hasAudio && options.audio
  const tooLong = format === "gif" && length > GIF_MAX_SECONDS
  const tooltip = !selection
    ? "Set in and out points first"
    : tooLong
      ? `GIFs are limited to ${GIF_MAX_SECONDS} seconds. Pick a shorter range.`
      : format === "gif"
        ? "Export the selection as a GIF (E)"
        : "Export the selection as an MP4 (E)"
  const sizeText = size ? ` · ${size.width}×${size.height}` : ""
  const tail = `${withAudio ? " · AAC stereo" : " · no audio"}${item.hdr.tonemap ? " · SDR" : ""}`
  const summary =
    format === "gif"
      ? `GIF${sizeText} · ${options.gifFps} fps · ${GIF_MAX_SECONDS} s max`
      : framed
        ? `MP4 H.264 · ${options.aspect}${sizeText}${shortSide ? "" : " native"}${options.cropZoom !== 1 ? ` · ${options.cropZoom.toFixed(2)}×` : ""}${options.cropWidth !== 1 ? ` · ${Math.round(options.cropWidth * 100)}% wide` : ""} · ${options.background} · bars trimmed${tail}`
        : `MP4 H.264${sizeText} · CRF ${options.quality === "high" ? 18 : options.quality === "small" ? 24 : 20} · bars trimmed${tail}`
  const buttonLabel = !selection
    ? "Set in and out first"
    : tooLong
      ? `GIFs are limited to ${GIF_MAX_SECONDS} seconds`
      : `Export ${lengthLabel}`
  const disabled = !selection || busy || tooLong
  return (
    <SplitButton
      label={selection ? `Export ${lengthLabel}` : "Export"}
      tooltip={tooltip}
      icon={<Scissors />}
      busy={busy}
      disabled={disabled}
      onPrimary={onExport}
      primaryVariant="default"
      optionsLabel="Export options"
      dialogClassName="h-[min(720px,calc(100vh-2rem))] w-[440px] sm:max-w-[440px]"
    >
      <div className="flex flex-col gap-3">
        <Field label="Format">
          <Choice
            value={format}
            options={[
              ["mp4", "Video"],
              ["gif", "GIF"],
            ]}
            onChange={(next) => onChange({ format: next })}
          />
        </Field>
        {format === "mp4" && (
          <>
            <Field label="Aspect">
              <Choice
                value={options.aspect}
                options={ASPECT_OPTIONS}
                onChange={(aspect) => onChange({ aspect })}
              />
            </Field>
            <Field label="Size">
              <Choice
                value={options.size}
                options={SIZE_OPTIONS}
                onChange={(next) =>
                  onChange({ size: next as ClipOptions["size"] })
                }
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
          </>
        )}
        {framed && (
          <>
            <CropPicker
              item={item}
              previewUrl={frameUrl(item.id, rangeStart, 640)}
              ratio={FRAME_RATIOS[options.aspect as FrameAspect]}
              focus={options.cropFocus}
              zoom={options.cropZoom}
              widthScale={options.cropWidth}
              background={options.background}
              lockX={options.lockX}
              lockY={options.lockY}
              bars={(bars.data ?? null) as BarsResponse | null}
              onChange={(patch) =>
                onChange({
                  ...(patch.focus ? { cropFocus: patch.focus } : {}),
                  ...(patch.zoom !== undefined ? { cropZoom: patch.zoom } : {}),
                  ...(patch.widthScale !== undefined
                    ? { cropWidth: patch.widthScale }
                    : {}),
                  ...(patch.lockX !== undefined ? { lockX: patch.lockX } : {}),
                  ...(patch.lockY !== undefined ? { lockY: patch.lockY } : {}),
                })
              }
            />
            <Field label="Zoom">
              <div className="flex items-center gap-2">
                <Slider
                  className="w-28"
                  min={CROP_ZOOM_RANGE.min}
                  max={CROP_ZOOM_RANGE.max}
                  step={0.05}
                  value={options.cropZoom}
                  onValueChange={(v) =>
                    onChange({
                      cropZoom: clampZoom(Array.isArray(v) ? v[0]! : v),
                    })
                  }
                  aria-label="Zoom"
                />
                <span className="tnum text-muted-foreground w-9 text-right text-xs">
                  {options.cropZoom.toFixed(2)}×
                </span>
              </div>
            </Field>
            <Field label="Width">
              <div className="flex items-center gap-2">
                <Slider
                  className="w-28"
                  min={CROP_WIDTH_RANGE.min * 100}
                  max={CROP_WIDTH_RANGE.max * 100}
                  step={5}
                  value={Math.round(options.cropWidth * 100)}
                  onValueChange={(v) =>
                    onChange({
                      cropWidth: clampWidth(
                        (Array.isArray(v) ? v[0]! : v) / 100
                      ),
                    })
                  }
                  aria-label="Picture width"
                />
                <span className="tnum text-muted-foreground w-9 text-right text-xs">
                  {Math.round(options.cropWidth * 100)}%
                </span>
              </div>
            </Field>
            <Field label="Background">
              <Choice
                value={options.background}
                options={[
                  ["black", "Black"],
                  ["blur", "Blur"],
                ]}
                onChange={(background) => onChange({ background })}
              />
            </Field>
          </>
        )}
        {format === "gif" && (
          <>
            <Field label="Width">
              <Choice
                value={String(options.gifWidth)}
                options={GIF_WIDTHS}
                onChange={(w) => onChange({ gifWidth: Number(w) as GifWidth })}
              />
            </Field>
            <Field label="Frame rate">
              <Choice
                value={String(options.gifFps)}
                options={GIF_FPS}
                onChange={(f) => onChange({ gifFps: Number(f) as GifFps })}
              />
            </Field>
          </>
        )}
        {format !== "gif" && (
          <Field label="Audio">
            <Switch
              size="sm"
              checked={hasAudio && options.audio}
              disabled={!hasAudio}
              onCheckedChange={(checked) => onChange({ audio: checked })}
              aria-label="Include audio"
            />
          </Field>
        )}
        <p className="tnum text-muted-foreground text-xs">{summary}</p>
        <Button
          size="sm"
          onClick={onExport}
          disabled={disabled}
          className="gap-1.5"
        >
          {busy ? <Loader2 className="animate-spin" /> : <Scissors />}{" "}
          {buttonLabel}
        </Button>
      </div>
    </SplitButton>
  )
}

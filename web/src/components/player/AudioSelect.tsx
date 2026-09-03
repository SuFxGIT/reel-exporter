import { Volume2 } from "lucide-react"
import type { AudioStream } from "@/lib/api"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface Props {
  streams: AudioStream[]
  value: number
  onChange: (index: number) => void
}

export function labelFor(s: AudioStream): string {
  const parts = [s.language ? s.language.toUpperCase() : `Track ${s.index + 1}`]
  if (s.title) parts.push(s.title)
  parts.push(`${s.codec.toUpperCase()} ${s.channels}ch`)
  return parts.join(" · ")
}

export function AudioSelect({ streams, value, onChange }: Props) {
  return (
    <Select
      value={String(value)}
      onValueChange={(v) => v !== null && onChange(Number(v))}
    >
      <SelectTrigger size="sm" className="max-w-56" aria-label="Audio track">
        <Volume2 className="text-muted-foreground size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {streams.map((s) => (
          <SelectItem key={s.index} value={String(s.index)}>
            {labelFor(s)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

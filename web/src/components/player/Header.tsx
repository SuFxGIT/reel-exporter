import { Menu } from "lucide-react"
import type { ItemDetail } from "@/lib/api"
import { formatDuration } from "@/lib/time"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AudioSelect } from "./AudioSelect"
import { ShortcutsHelp } from "./ShortcutsHelp"
import { SupportLinks } from "./SupportLinks"

interface Props {
  item: ItemDetail
  audio: number
  onAudioChange: (index: number) => void
  onToggleSidebar: () => void
}

const hdrLabel: Record<ItemDetail["hdr"]["kind"], string | null> = {
  sdr: null,
  pq: "HDR10",
  hlg: "HLG",
  "dovi-p5": "Dolby Vision p5",
  "unknown-hdr": "HDR",
}

export function Header({ item, audio, onAudioChange, onToggleSidebar }: Props) {
  const v = item.video
  const hdr = hdrLabel[item.hdr.kind]
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
      <Button
        variant="ghost"
        size="icon-sm"
        className="lg:hidden"
        onClick={onToggleSidebar}
        aria-label="Toggle library"
      >
        <Menu />
      </Button>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="truncate text-[15px] font-semibold" dir="auto">
          {item.title}
        </h1>
        {item.year && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {item.year}
          </span>
        )}
        {item.type === "episode" && (
          <span className="text-muted-foreground truncate text-xs">
            <span className="tabular-nums">{item.episodeLabel}</span>
            {item.episodeTitle && (
              <>
                {" · "}
                <span dir="auto">{item.episodeTitle}</span>
              </>
            )}
          </span>
        )}
      </div>
      <div className="hidden items-center gap-1 md:flex">
        {v && (
          <Badge variant="secondary" className="tabular-nums">
            {v.displayWidth}×{v.height}
          </Badge>
        )}
        {v && <Badge variant="secondary">{v.codec.toUpperCase()}</Badge>}
        {hdr && (
          <Badge variant={item.hdr.tonemap ? "secondary" : "destructive"}>
            {hdr}
          </Badge>
        )}
        {!item.hasVideo && <Badge variant="destructive">audio only</Badge>}
        <Badge variant="secondary" className="tabular-nums">
          {formatDuration(item.duration)}
        </Badge>
      </div>
      {item.audio.length > 1 && (
        <AudioSelect
          streams={item.audio}
          value={audio}
          onChange={onAudioChange}
        />
      )}
      <ShortcutsHelp />
      <SupportLinks className="flex items-center" />
    </header>
  )
}

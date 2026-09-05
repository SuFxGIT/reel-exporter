import { Coffee } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const links = [
  {
    href: "https://github.com/SuFxGIT/reel-exporter",
    label: "Reel Exporter on GitHub",
    icon: <GitHubMark />,
  },
  {
    href: "https://buymeacoffee.com/sufx",
    label: "Buy me a coffee",
    icon: <Coffee />,
  },
]

/** GitHub and Buy Me a Coffee icons that sit in the top-right corner. */
export function SupportLinks({ className }: { className?: string }) {
  return (
    <div className={className}>
      {links.map((l) => (
        <Tooltip key={l.href}>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                render={
                  <a
                    href={l.href}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={l.label}
                  />
                }
              />
            }
          >
            {l.icon}
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            {l.label}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/** The GitHub mark. lucide dropped brand icons, so it is inlined. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.35.78 1.05.78 2.12v3.14c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  )
}

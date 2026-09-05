import { useEffect, useState } from "react"
import { Clapperboard, X } from "lucide-react"
import { Toaster } from "sonner"
import { Sidebar } from "@/components/sidebar/Sidebar"
import { Player } from "@/components/player/Player"
import { SupportLinks } from "@/components/player/SupportLinks"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { useHashRoute } from "@/lib/hash-route"
import { useItem } from "@/lib/queries"

export default function App() {
  const { itemId, navigate } = useHashRoute()
  const item = useItem(itemId)
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    setDrawer(false)
  }, [itemId])

  const sidebar = (
    <Sidebar
      selectedId={itemId}
      selectedItem={item.data}
      onSelect={(id) => navigate(id)}
    />
  )

  return (
    <TooltipProvider>
      <div className="flex h-full w-full">
        <div className="hidden w-[280px] shrink-0 border-r lg:block">
          {sidebar}
        </div>
        {drawer && (
          <div className="fixed inset-0 z-40 flex lg:hidden">
            <div className="h-full w-[300px] max-w-[85vw] border-r shadow-2xl">
              {sidebar}
            </div>
            <button
              type="button"
              className="flex-1 bg-black/50"
              aria-label="Close library"
              onClick={() => setDrawer(false)}
            />
            <Button
              variant="secondary"
              size="icon-sm"
              className="absolute top-2 right-2"
              onClick={() => setDrawer(false)}
              aria-label="Close"
            >
              <X />
            </Button>
          </div>
        )}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {!item.data && (
            <SupportLinks className="absolute top-2 right-2 flex items-center" />
          )}
          {item.data ? (
            <Player
              key={item.data.id}
              item={item.data}
              onToggleSidebar={() => setDrawer((d) => !d)}
              onClose={() => navigate(null)}
            />
          ) : (
            <EmptyState
              loading={item.isLoading}
              error={item.error ? (item.error as Error).message : null}
              onOpen={() => setDrawer(true)}
              hasSelection={itemId !== null}
            />
          )}
        </main>
      </div>
      <Toaster
        theme="dark"
        position="bottom-right"
        closeButton
        richColors={false}
        toastOptions={{ className: "text-sm" }}
      />
    </TooltipProvider>
  )
}

function EmptyState({
  loading,
  error,
  onOpen,
  hasSelection,
}: {
  loading: boolean
  error: string | null
  onOpen: () => void
  hasSelection: boolean
}) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Clapperboard className="size-10 opacity-40" />
      {loading && hasSelection ? (
        <p className="text-sm">Reading the file</p>
      ) : error ? (
        <p className="text-destructive max-w-md text-sm">{error}</p>
      ) : (
        <>
          <p className="text-sm">
            Pick a movie or an episode from the library to start.
          </p>
          <p className="text-xs">
            Play, set in and out points on the timeline, then save screenshots
            or export clips from the original file.
          </p>
        </>
      )}
      <Button
        variant="outline"
        size="sm"
        className="lg:hidden"
        onClick={onOpen}
      >
        Open library
      </Button>
    </div>
  )
}

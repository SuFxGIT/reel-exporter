import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { FolderPlus, HardDrive, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api, type LibrarySelection, type Source } from "@/lib/api"
import { useInvalidate, useSources } from "@/lib/queries"
import { sameSelection, serverSelection } from "@/lib/sources"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { FolderBrowser } from "./FolderBrowser"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  scanning: boolean
  /** Prefills the add-source input when the dialog opens (first-run hint). */
  initialPath?: string | null
  returnFocusRef?: RefObject<HTMLElement | null>
}

export function SourcesDialog({
  open,
  onOpenChange,
  scanning,
  initialPath,
  returnFocusRef,
}: Props) {
  const sources = useSources({ enabled: open })
  const invalidate = useInvalidate()
  const qc = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Map<string, LibrarySelection[]>>(
    () => new Map()
  )
  const [addPath, setAddPath] = useState("")
  const [addError, setAddError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const wasOpen = useRef(false)

  // Fresh state every time the dialog opens.
  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(new Map())
      setAddPath(initialPath ?? "")
      setAddError(null)
      setConfirmRemove(null)
    }
    wasOpen.current = open
  }, [open, initialPath])

  const list = useMemo(() => sources.data?.sources ?? [], [sources.data])
  const candidates = sources.data?.candidates ?? []
  const active = list.find((s) => s.id === activeId) ?? list[0] ?? null

  useEffect(() => {
    if (!activeId && list.length > 0) setActiveId(list[0]!.id)
    if (activeId && !list.some((s) => s.id === activeId))
      setActiveId(list[0]?.id ?? null)
  }, [list, activeId])

  const effective = useCallback(
    (s: Source): LibrarySelection[] => draft.get(s.id) ?? serverSelection(s),
    [draft]
  )
  const isDirty = useCallback(
    (s: Source): boolean =>
      draft.has(s.id) && !sameSelection(draft.get(s.id)!, serverSelection(s)),
    [draft]
  )
  const changes = list
    .filter(isDirty)
    .map((s) => ({ id: s.id, libraries: draft.get(s.id)! }))
  const dirty = changes.length > 0

  const add = useMutation({
    mutationFn: (p: string) => api.addSource(p),
    onSuccess: async (source) => {
      setAddError(null)
      setAddPath("")
      await invalidate.sources()
      setActiveId(source.id)
    },
    onError: (err) => setAddError((err as Error).message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.removeSource(id),
    onSuccess: async (_, id) => {
      setDraft((d) => {
        const n = new Map(d)
        n.delete(id)
        return n
      })
      qc.removeQueries({ queryKey: ["browse", id] })
      setConfirmRemove(null)
      await Promise.all([invalidate.sources(), invalidate.library()])
      toast("Source removed. Rescanning the library")
    },
    onError: (err) =>
      toast.error("Could not remove the source", {
        description: (err as Error).message,
      }),
  })

  const save = useMutation({
    mutationFn: async (batch: typeof changes) => {
      const saved: string[] = []
      try {
        for (const c of batch) {
          await api.setLibraries(c.id, c.libraries)
          saved.push(c.id)
        }
      } catch (err) {
        throw Object.assign(err as Error, { saved })
      }
      return saved
    },
    onSuccess: (saved) => {
      setDraft((d) => {
        const n = new Map(d)
        saved.forEach((id) => n.delete(id))
        return n
      })
      toast("Rescanning the library")
      onOpenChange(false)
    },
    onError: (err) => {
      const saved = (err as Error & { saved?: string[] }).saved ?? []
      setDraft((d) => {
        const n = new Map(d)
        saved.forEach((id) => n.delete(id))
        return n
      })
      toast.error("Could not save the libraries", {
        description: (err as Error).message,
      })
    },
    onSettled: () => {
      void invalidate.sources()
      void invalidate.library()
    },
  })

  const submitAdd = (e?: React.FormEvent) => {
    e?.preventDefault()
    const p = addPath.trim()
    if (!p.startsWith("/")) {
      setAddError(
        "Enter an absolute path inside the container, for example /media."
      )
      return
    }
    add.mutate(p)
  }

  return (
    <Dialog
      open={open}
      disablePointerDismissal={dirty}
      onOpenChange={(next, details) => {
        if (
          !next &&
          (renaming || confirmRemove) &&
          details.reason === "escape-key"
        ) {
          details.cancel()
          setConfirmRemove(null)
          return
        }
        onOpenChange(next)
      }}
    >
      <DialogContent
        finalFocus={returnFocusRef}
        showCloseButton
        className="flex h-[min(640px,calc(100dvh-2rem))] w-full flex-col gap-0 p-0 sm:max-w-3xl"
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>Media sources</DialogTitle>
          <DialogDescription>
            Add folders mounted into the container, then tick the folders that
            should appear as libraries. Unticked folders are never scanned, and
            nothing is ever written to a source.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="flex max-h-48 min-h-0 flex-col border-b sm:max-h-none sm:border-r sm:border-b-0">
            <div className="text-muted-foreground px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide uppercase">
              Sources
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {sources.isLoading && (
                <li className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
                  <Loader2 className="size-3.5 animate-spin" /> Loading
                </li>
              )}
              {list.length === 0 && !sources.isLoading && (
                <li className="text-muted-foreground px-3 py-2 text-xs">
                  No sources yet. Add the folder where your media is mounted.
                </li>
              )}
              {list.map((s) => {
                const libs = effective(s)
                const rowDirty = isDirty(s)
                const isActive = active?.id === s.id
                return (
                  <li key={s.id} className="group/source">
                    <div
                      className={cn(
                        "flex items-start gap-1 pr-1",
                        isActive && "bg-primary/10"
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveId(s.id)}
                        aria-current={isActive ? "true" : undefined}
                        className="focus-visible:bg-muted/60 flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left outline-none"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <HardDrive className="size-3.5 shrink-0 opacity-70" />
                          <span
                            className="truncate text-[13px] font-medium"
                            dir="ltr"
                            title={s.path}
                          >
                            {s.path}
                          </span>
                          {!s.exists ? (
                            <Badge variant="destructive" className="shrink-0">
                              not mounted
                            </Badge>
                          ) : s.readOnly ? (
                            <Badge variant="secondary" className="shrink-0">
                              read-only
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="border-primary/40 text-primary shrink-0"
                              title="Mounted read-write. Add :ro to the mount so the app can never modify your media."
                            >
                              writable
                            </Badge>
                          )}
                        </span>
                        {s.hostPath && (
                          <span
                            className="text-muted-foreground truncate text-[11px]"
                            dir="ltr"
                            title={s.hostPath}
                          >
                            {s.hostPath}
                          </span>
                        )}
                        <span className="tnum text-muted-foreground text-[11px]">
                          {libs.length}{" "}
                          {libs.length === 1 ? "library" : "libraries"}
                          {rowDirty && (
                            <span className="text-primary"> · unsaved</span>
                          )}
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${s.path}`}
                        onClick={() => setConfirmRemove(s.id)}
                        className="mt-2 opacity-0 group-hover/source:opacity-100 focus-visible:opacity-100"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    {confirmRemove === s.id && (
                      <div className="bg-destructive/10 flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
                        <span>
                          Remove this source and its {s.libraries.length}{" "}
                          {s.libraries.length === 1 ? "library" : "libraries"}?
                          Captures are not affected.
                        </span>
                        <Button
                          size="xs"
                          variant="destructive"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(s.id)}
                        >
                          Remove
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setConfirmRemove(null)}
                        >
                          Keep
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <form onSubmit={submitAdd} className="border-t p-2">
              {candidates.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {candidates.map((c) => (
                    <button
                      key={c.path}
                      type="button"
                      title={c.hostPath}
                      onClick={() => {
                        setAddPath(c.path)
                        setAddError(null)
                        add.mutate(c.path)
                      }}
                      className="border-border hover:bg-muted rounded-full border px-2 py-0.5 text-[11px]"
                    >
                      + {c.path}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Input
                  value={addPath}
                  onChange={(e) => {
                    setAddPath(e.target.value)
                    setAddError(null)
                  }}
                  placeholder="/media2"
                  aria-label="Container path of a mounted media folder"
                  aria-invalid={addError ? true : undefined}
                  aria-describedby={addError ? "add-source-error" : undefined}
                  disabled={add.isPending}
                  className="h-7 text-[13px]"
                  dir="ltr"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={add.isPending || !addPath.trim()}
                  className="gap-1"
                >
                  {add.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Plus />
                  )}{" "}
                  Add
                </Button>
              </div>
              {addError && (
                <p
                  id="add-source-error"
                  className="text-destructive mt-1 text-xs"
                >
                  {addError}
                </p>
              )}
            </form>
          </aside>

          <section className="flex min-h-0 flex-col">
            {active ? (
              <FolderBrowser
                key={active.id}
                source={active}
                selection={effective(active)}
                onChange={(next) =>
                  setDraft((d) => new Map(d).set(active.id, next))
                }
                onRenamingChange={setRenaming}
              />
            ) : (
              <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
                <FolderPlus className="size-8 opacity-40" />
                <p>Add a source to browse its folders.</p>
              </div>
            )}
          </section>
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
          <span className="text-muted-foreground text-xs">
            {scanning
              ? "Scanning now"
              : dirty
                ? `${changes.length} ${changes.length === 1 ? "source" : "sources"} changed. Saving rescans them.`
                : sources.data && !sources.data.persistent
                  ? "Config folder is not writable: changes are lost when the container restarts."
                  : ""}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              {dirty ? "Discard" : "Close"}
            </Button>
            <Button
              size="sm"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate(changes)}
              className="gap-1.5"
            >
              {save.isPending && <Loader2 className="animate-spin" />} Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

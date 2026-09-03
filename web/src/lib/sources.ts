import type { LibrarySelection, Source } from "./api"

export const lastSegment = (p: string): string => {
  const parts = p.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** True when `outer` is a strict ancestor folder of `inner` ("." is the root). */
export const isAncestor = (outer: string, inner: string): boolean =>
  outer !== inner &&
  (outer === "." ? inner !== "." : inner.startsWith(`${outer}/`))

export interface BlockReason {
  kind: "inside" | "contains"
  name: string
}

/** Why a folder cannot be ticked: a selected ancestor or descendant. */
export function blockedBy(
  relPath: string,
  selected: LibrarySelection[],
  sourcePath: string
): BlockReason | null {
  for (const s of selected) {
    if (s.relPath === relPath) continue
    if (isAncestor(s.relPath, relPath))
      return { kind: "inside", name: displayName(s, sourcePath) }
    if (isAncestor(relPath, s.relPath))
      return { kind: "contains", name: displayName(s, sourcePath) }
  }
  return null
}

export const toggleSelection = (
  list: LibrarySelection[],
  relPath: string,
  on: boolean
): LibrarySelection[] =>
  on
    ? list.some((l) => l.relPath === relPath)
      ? list
      : [...list, { relPath }]
    : list.filter((l) => l.relPath !== relPath)

export const renameSelection = (
  list: LibrarySelection[],
  relPath: string,
  name: string | undefined
): LibrarySelection[] =>
  list.map((l) =>
    l.relPath === relPath ? (name ? { relPath, name } : { relPath }) : l
  )

const sorted = (list: LibrarySelection[]): LibrarySelection[] =>
  [...list].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  )

export function sameSelection(
  a: LibrarySelection[],
  b: LibrarySelection[]
): boolean {
  if (a.length !== b.length) return false
  const sa = sorted(a)
  const sb = sorted(b)
  return sa.every(
    (x, i) =>
      x.relPath === sb[i]!.relPath && (x.name ?? "") === (sb[i]!.name ?? "")
  )
}

/** Display name for a selection entry before the server has title-cased it. */
export const displayName = (l: LibrarySelection, sourcePath: string): string =>
  l.name ??
  (l.relPath === "." ? lastSegment(sourcePath) : lastSegment(l.relPath))

export const parentOf = (rel: string): string => {
  const i = rel.lastIndexOf("/")
  return i < 0 ? "." : rel.slice(0, i)
}

/** The selection the server currently has for a source, as the client edits it. */
export const serverSelection = (source: Source): LibrarySelection[] =>
  source.libraries.map((l) =>
    l.customName
      ? { relPath: l.relPath, name: l.customName }
      : { relPath: l.relPath }
  )

import { promises as fs } from "node:fs"
import path from "node:path"

/** One line of /proc/self/mountinfo. */
export interface MountEntry {
  id: number
  parentId: number
  /** Path inside the backing filesystem (for Unraid shares: relative to /mnt/user). */
  root: string
  mountPoint: string
  /** Per-mount options (field 6); this is where a read-only bind shows `ro`. */
  options: string[]
  fsType: string
  source: string
  superOptions: string[]
  readOnly: boolean
}

/** A mounted folder the user could add as a media source. */
export interface MountCandidate {
  path: string
  hostPath?: string
  readOnly: boolean
  fsType: string
}

const SYSTEM_FS = new Set([
  "proc",
  "sysfs",
  "tmpfs",
  "devtmpfs",
  "devpts",
  "mqueue",
  "cgroup",
  "cgroup2",
  "overlay",
  "squashfs",
  "securityfs",
  "debugfs",
  "tracefs",
  "configfs",
  "fusectl",
  "binfmt_misc",
  "pstore",
  "efivarfs",
  "bpf",
  "hugetlbfs",
  "autofs",
  "nsfs",
  "rpc_pipefs",
  "ramfs",
  "rootfs",
])

const SYSTEM_PREFIXES = ["/proc", "/sys", "/dev", "/etc", "/run"]

/** mountinfo escapes spaces and a few other characters as octal (`\040`). */
const unescape = (s: string): string =>
  s.replace(/\\([0-7]{3})/g, (_, oct: string) =>
    String.fromCharCode(parseInt(oct, 8))
  )

/** True when `p` equals `base` or lives below it. */
export function isUnder(p: string, base: string): boolean {
  if (base === "/") return true
  return p === base || p.startsWith(base.endsWith("/") ? base : `${base}/`)
}

export function parseMountInfo(text: string): MountEntry[] {
  const out: MountEntry[] = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const fields = line.split(" ")
    const sep = fields.indexOf("-", 6)
    if (sep < 0 || fields.length < sep + 3) continue
    const id = Number(fields[0])
    const parentId = Number(fields[1])
    if (!Number.isFinite(id) || !Number.isFinite(parentId)) continue
    const options = (fields[5] ?? "").split(",").filter(Boolean)
    out.push({
      id,
      parentId,
      root: unescape(fields[3] ?? "/"),
      mountPoint: unescape(fields[4] ?? ""),
      options,
      fsType: fields[sep + 1] ?? "",
      source: unescape(fields[sep + 2] ?? ""),
      superOptions: (fields[sep + 3] ?? "").split(",").filter(Boolean),
      readOnly: options.includes("ro"),
    })
  }
  return out
}

/**
 * Picks the mounts that look like media folders: no system filesystems, nothing under
 * system prefixes or excluded app paths, and nested submounts collapsed into their
 * parent (Unraid mounts share sub-paths separately, e.g. /media/movies under /media).
 */
export function selectCandidates(
  entries: MountEntry[],
  opts: { exclude: string[] }
): MountCandidate[] {
  const byPoint = new Map<string, MountEntry>()
  for (const e of entries) {
    if (!e.mountPoint || e.mountPoint === "/") continue
    if (SYSTEM_FS.has(e.fsType)) continue
    if (SYSTEM_PREFIXES.some((p) => isUnder(e.mountPoint, p))) continue
    if (opts.exclude.some((x) => x && x !== "/" && isUnder(e.mountPoint, x)))
      continue
    byPoint.set(e.mountPoint, e) // a later line shadows an earlier mount of the same point
  }
  const kept: string[] = []
  for (const mp of [...byPoint.keys()].sort()) {
    if (kept.some((k) => mp.startsWith(`${k}/`))) continue
    kept.push(mp)
  }
  return kept.map((mp) => {
    const e = byPoint.get(mp)!
    let hostPath: string | undefined
    if (e.fsType === "fuse.shfs")
      hostPath = path.posix.join("/mnt/user", e.root)
    else if (e.root && e.root !== "/") hostPath = e.root
    return {
      path: mp,
      ...(hostPath ? { hostPath } : {}),
      readOnly: e.readOnly,
      fsType: e.fsType,
    }
  })
}

export async function readMountInfo(
  file = "/proc/self/mountinfo"
): Promise<MountEntry[]> {
  try {
    return parseMountInfo(await fs.readFile(file, "utf8"))
  } catch {
    return []
  }
}

export async function detectMounts(
  opts: { file?: string; exclude?: string[] } = {}
): Promise<MountCandidate[]> {
  const entries = await readMountInfo(opts.file)
  return selectCandidates(entries, { exclude: opts.exclude ?? [] })
}

/** The closest mount that contains `p`, or null when it lives on the root filesystem. */
export function mountFor(
  candidates: MountCandidate[],
  p: string
): MountCandidate | null {
  let best: MountCandidate | null = null
  for (const c of candidates) {
    if (isUnder(p, c.path) && (!best || c.path.length > best.path.length))
      best = c
  }
  return best
}

export function isMountPoint(entries: MountEntry[], p: string): boolean {
  return entries.some((e) => e.mountPoint === p)
}

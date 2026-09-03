import path from "node:path"

/**
 * Resolves a user-supplied relative path inside `root` and rejects anything that
 * escapes it. Returns the absolute path or null.
 */
export function resolveInside(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null
  const normalized = rel.replace(/\\/g, "/")
  if (path.posix.isAbsolute(normalized)) return null
  if (normalized.split("/").some((seg) => seg === "..")) return null
  const abs = path.resolve(root, normalized)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

export function toUrlPath(rel: string): string {
  return rel.split("/").map(encodeURIComponent).join("/")
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0")

/** 754.567 -> "00:12:34.567" (ms optional). */
export function formatTime(seconds: number, withMs = true): string {
  if (!Number.isFinite(seconds)) seconds = 0
  const t = Math.max(0, seconds)
  const whole = Math.floor(t)
  const ms = Math.min(999, Math.round((t - whole) * 1000))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`
  return withMs ? `${base}.${pad(ms, 3)}` : base
}

/** Compact duration for badges: "1h 52m", "42m", "35s". */
export function formatDuration(seconds: number): string {
  const t = Math.max(0, Math.round(seconds))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  if (h > 0) return `${h}h ${pad(m)}m`
  if (m > 0) return `${m}m ${pad(t % 60)}s`
  return `${t}s`
}

/** Ruler labels: "1:23:45" or "12:34" or "0:05". */
export function formatRuler(seconds: number): string {
  const t = Math.max(0, Math.round(seconds))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

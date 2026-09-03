import { promises as fs } from "node:fs"
import path from "node:path"

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

export interface WaitOptions {
  intervalMs?: number
  timeoutMs: number
  /** Optional early-abort check; when it returns a string the wait rejects with that reason. */
  abort?: () => string | null
}

/** Polls `check` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  check: () =>
    Promise<T | null | undefined | false> | T | null | undefined | false,
  opts: WaitOptions
): Promise<T> {
  const interval = opts.intervalMs ?? 100
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    const v = await check()
    if (v) return v
    const reason = opts.abort?.()
    if (reason) throw new Error(reason)
    if (Date.now() >= deadline) throw new Error("timeout")
    await sleep(interval)
  }
}

/** Writes JSON to a temp file in the same directory, then renames it into place. */
export async function atomicWriteJson(
  file: string,
  data: unknown
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data), "utf8")
  await fs.rename(tmp, file)
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T
  } catch {
    return null
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function isWritableDir(p: string): Promise<boolean> {
  try {
    await fs.mkdir(p, { recursive: true })
    const probe = path.join(p, `.rv-write-test-${process.pid}`)
    await fs.writeFile(probe, "")
    await fs.unlink(probe)
    return true
  } catch {
    return false
  }
}

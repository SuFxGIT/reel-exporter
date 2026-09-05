import { promises as fs } from "node:fs"
import { z } from "zod"
import type { Logger } from "../logger.js"
import { atomicWriteJson } from "../util/async.js"

/**
 * Remembers the order of a title's captures in the strip. Files keep their
 * names; only this list changes when a tile is dragged.
 */
const fileSchema = z.object({
  version: z.literal(1),
  order: z.record(z.string(), z.array(z.string())),
})
type OrderFile = z.infer<typeof fileSchema>

export interface CaptureOrderOptions {
  file: string
  writable: boolean
  log?: Logger
}

export class CaptureOrderStore {
  private order: Record<string, string[]> = {}
  private chain: Promise<unknown> = Promise.resolve()
  private warned = false
  private readonly opts: CaptureOrderOptions

  constructor(opts: CaptureOrderOptions) {
    this.opts = opts
  }

  get persistent(): boolean {
    return this.opts.writable
  }

  async load(): Promise<"loaded" | "missing" | "invalid"> {
    let text: string
    try {
      text = await fs.readFile(this.opts.file, "utf8")
    } catch {
      return "missing"
    }
    try {
      this.order = fileSchema.parse(JSON.parse(text)).order
      return "loaded"
    } catch (err) {
      this.opts.log?.warn(
        { file: this.opts.file, err },
        "captures: captures.json is invalid and will be rebuilt"
      )
      this.order = {}
      return "invalid"
    }
  }

  /** Remembered order for a capture folder (relPaths), oldest first. */
  get(folder: string): string[] {
    return [...(this.order[folder] ?? [])]
  }

  set(folder: string, relPaths: string[]): Promise<void> {
    return this.mutate(async () => {
      if (relPaths.length === 0) delete this.order[folder]
      else this.order[folder] = [...new Set(relPaths)]
      await this.save()
    })
  }

  /** A file was renamed: keep its slot under the new relPath. */
  replace(from: string, to: string): Promise<void> {
    return this.mutate(async () => {
      let changed = false
      for (const list of Object.values(this.order)) {
        const i = list.indexOf(from)
        if (i >= 0) {
          list[i] = to
          changed = true
        }
      }
      if (changed) await this.save()
    })
  }

  /** A file was deleted: forget it everywhere. */
  remove(relPath: string): Promise<void> {
    return this.mutate(async () => {
      let changed = false
      for (const [folder, list] of Object.entries(this.order)) {
        const next = list.filter((p) => p !== relPath)
        if (next.length !== list.length) {
          changed = true
          if (next.length === 0) delete this.order[folder]
          else this.order[folder] = next
        }
      }
      if (changed) await this.save()
    })
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async save(): Promise<void> {
    if (!this.opts.writable) {
      if (!this.warned) {
        this.warned = true
        this.opts.log?.warn(
          { file: this.opts.file },
          "captures: captures.json cannot be written; tile order is lost on restart"
        )
      }
      return
    }
    const data: OrderFile = { version: 1, order: this.order }
    await atomicWriteJson(this.opts.file, data)
  }
}

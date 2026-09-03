import { promises as fs } from "node:fs"
import { randomBytes } from "node:crypto"
import PQueue from "p-queue"
import { formatTimestampForName } from "../library/naming.js"
import type { PlayableInfo } from "../library/store.js"
import { logger } from "../logger.js"
import {
  allocateCapture,
  captureUrls,
  releaseCapture,
  type CaptureTarget,
} from "./capture.js"
import {
  exited,
  killProcess,
  lineSplitter,
  parseProgressLine,
  spawnFfmpeg,
  type RegisteredProcess,
} from "./ffmpeg.js"
import { fullResFilters, inputArgs, colorTagArgs } from "./filters.js"
import type { ProbeResult } from "./probe.js"

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled"

export type ClipQuality = "high" | "balanced" | "small"

export interface ClipParams {
  start: number
  end: number
  /** Audio stream index, or -1 for no audio. */
  audio: number
  quality: ClipQuality
  /** Downscale so the width is at most this many pixels; omit for source resolution. */
  maxWidth?: number
}

const QUALITY: Record<ClipQuality, { crf: string; preset: string }> = {
  high: { crf: "18", preset: "medium" },
  balanced: { crf: "20", preset: "medium" },
  small: { crf: "24", preset: "fast" },
}

export interface Job {
  id: string
  type: "clip"
  itemId: string
  status: JobStatus
  progress: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  params: ClipParams
  output?: {
    relPath: string
    name: string
    size: number
    url: string
    thumbUrl: string
    downloadUrl: string
  }
  error?: string
}

interface Internal {
  job: Job
  info: PlayableInfo
  probe: ProbeResult
  entry: RegisteredProcess | null
  target: CaptureTarget | null
  cancelled: boolean
}

const log = logger.child({ mod: "jobs" })
const KEEP_MS = 60 * 60_000

class JobManager {
  private readonly jobs = new Map<string, Internal>()
  private readonly queue = new PQueue({ concurrency: 1 })
  private sweeper: NodeJS.Timeout | null = null

  start(): void {
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
  }

  get(id: string): Job | null {
    return this.jobs.get(id)?.job ?? null
  }

  list(itemId?: string): Job[] {
    return [...this.jobs.values()]
      .map((j) => j.job)
      .filter((j) => !itemId || j.itemId === itemId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  running(): number {
    return [...this.jobs.values()].filter(
      (j) => j.job.status === "queued" || j.job.status === "running"
    ).length
  }

  createClip(info: PlayableInfo, probe: ProbeResult, params: ClipParams): Job {
    const id = `job_${randomBytes(6).toString("base64url")}`
    const job: Job = {
      id,
      type: "clip",
      itemId: info.item.id,
      status: "queued",
      progress: 0,
      createdAt: new Date().toISOString(),
      params,
    }
    const internal: Internal = {
      job,
      info,
      probe,
      entry: null,
      target: null,
      cancelled: false,
    }
    this.jobs.set(id, internal)
    void this.queue.add(() => this.runClip(internal))
    return job
  }

  async cancel(id: string): Promise<boolean> {
    const internal = this.jobs.get(id)
    if (!internal) return false
    const { job } = internal
    if (job.status !== "queued" && job.status !== "running") return false
    internal.cancelled = true
    if (internal.entry) await killProcess(internal.entry)
    job.status = "cancelled"
    job.finishedAt = new Date().toISOString()
    return true
  }

  private async runClip(internal: Internal): Promise<void> {
    const { job, info, probe } = internal
    if (internal.cancelled) return
    job.status = "running"
    job.startedAt = new Date().toISOString()
    const { start, end, audio, quality, maxWidth } = job.params
    const duration = end - start
    const q = QUALITY[quality] ?? QUALITY.balanced
    const suffix = `${formatTimestampForName(start)} to ${formatTimestampForName(end)}`
    let target: CaptureTarget | null = null
    try {
      target = await allocateCapture(info, suffix, "mp4")
      internal.target = target
      const tmp = `${target.absPath}.tmp.mp4`
      const hasAudio = audio >= 0 && audio < probe.audio.length
      const args = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-nostats",
        "-y",
        "-progress",
        "pipe:1",
        "-stats_period",
        "0.5",
        "-threads",
        "8",
        ...inputArgs(probe),
        "-ss",
        start.toFixed(3),
        "-i",
        info.absPath,
        "-t",
        duration.toFixed(3),
      ]
      if (probe.hasVideo) args.push("-map", "0:V:0")
      if (hasAudio) args.push("-map", `0:a:${audio}`)
      args.push("-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1")
      if (probe.hasVideo) {
        args.push(
          "-filter_threads",
          "4",
          "-vf",
          fullResFilters(probe, "yuv420p", "field", maxWidth),
          "-c:v",
          "libx264",
          "-preset",
          q.preset,
          "-crf",
          q.crf,
          "-profile:v",
          "high",
          "-pix_fmt",
          "yuv420p",
          "-threads:v",
          "12",
          ...colorTagArgs(probe)
        )
      }
      if (hasAudio)
        args.push("-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k")
      args.push(
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        tmp
      )

      const entry = spawnFfmpeg(args, { kind: `clip:${job.id}`, nice: 10 })
      internal.entry = entry
      const stderr: string[] = []
      entry.proc.stdout?.on(
        "data",
        lineSplitter((line) => {
          const p = parseProgressLine(line)
          if (p?.key === "out_time_us") {
            const us = Number(p.value)
            if (Number.isFinite(us) && duration > 0)
              job.progress = Math.min(
                0.99,
                Math.max(job.progress, us / (duration * 1e6))
              )
          }
        })
      )
      entry.proc.stderr?.on(
        "data",
        lineSplitter((line) => {
          if (line.trim()) stderr.push(line)
          if (stderr.length > 30) stderr.shift()
        })
      )
      const code = await exited(entry.proc)
      internal.entry = null
      if (internal.cancelled) {
        await fs.unlink(tmp).catch(() => undefined)
        return
      }
      const st = await fs.stat(tmp).catch(() => null)
      if (code !== 0 || !st || st.size === 0) {
        await fs.unlink(tmp).catch(() => undefined)
        throw new Error(
          `ffmpeg failed (exit ${code ?? "killed"}): ${stderr.slice(-3).join(" | ") || "no details"}`
        )
      }
      await fs.rename(tmp, target.absPath)
      job.progress = 1
      job.status = "done"
      job.output = {
        relPath: target.relPath,
        name: target.name,
        size: st.size,
        ...captureUrls(target.relPath),
      }
      log.info(
        {
          job: job.id,
          file: target.relPath,
          seconds: duration,
          ms: Date.now() - Date.parse(job.startedAt),
        },
        "clip saved"
      )
    } catch (err) {
      if (!internal.cancelled) {
        job.status = "failed"
        job.error = (err as Error).message
        log.warn({ job: job.id, err: job.error }, "clip failed")
      }
    } finally {
      job.finishedAt = new Date().toISOString()
      if (target) releaseCapture(target)
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - KEEP_MS
    for (const [id, j] of this.jobs) {
      if (j.job.finishedAt && Date.parse(j.job.finishedAt) < cutoff)
        this.jobs.delete(id)
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    for (const j of this.jobs.values()) {
      if (j.job.status === "running" || j.job.status === "queued")
        await this.cancel(j.job.id)
    }
  }
}

export const jobs = new JobManager()

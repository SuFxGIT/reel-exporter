import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import { config } from "../config.js"
import { logger } from "../logger.js"
import { sleep } from "../util/async.js"

export interface RegisteredProcess {
  pid: number
  kind: string
  startedAt: number
  proc: ChildProcess
  /** True while the process is SIGSTOPped; it must be continued before it can die. */
  stopped: boolean
}

/** Every ffmpeg/ffprobe child goes through here so shutdown can kill them all. */
class ProcessRegistry {
  private readonly procs = new Map<number, RegisteredProcess>()

  register(proc: ChildProcess, kind: string): RegisteredProcess {
    const entry: RegisteredProcess = {
      pid: proc.pid ?? -1,
      kind,
      startedAt: Date.now(),
      proc,
      stopped: false,
    }
    if (proc.pid) {
      this.procs.set(proc.pid, entry)
      proc.once("exit", () => this.procs.delete(entry.pid))
    }
    return entry
  }

  list(): RegisteredProcess[] {
    return [...this.procs.values()]
  }

  get size(): number {
    return this.procs.size
  }

  async killAll(): Promise<void> {
    await Promise.all(this.list().map((p) => killProcess(p)))
  }

  /** Last resort on process exit: synchronous SIGKILL for anything still alive. */
  killAllSync(): void {
    for (const p of this.procs.values()) {
      try {
        p.proc.kill("SIGCONT")
        p.proc.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }
  }
}

export const processes = new ProcessRegistry()

export function exited(proc: ChildProcess): Promise<number | null> {
  if (proc.exitCode !== null || proc.signalCode !== null)
    return Promise.resolve(proc.exitCode)
  return new Promise((resolve) => proc.once("exit", (code) => resolve(code)))
}

/** SIGCONT (a stopped process ignores SIGTERM), SIGTERM, then SIGKILL after `graceMs`. */
export async function killProcess(
  entry: RegisteredProcess,
  graceMs = 2000
): Promise<void> {
  const { proc } = entry
  if (proc.exitCode !== null || proc.signalCode !== null) return
  try {
    if (entry.stopped) {
      proc.kill("SIGCONT")
      entry.stopped = false
    }
    proc.kill("SIGTERM")
  } catch {
    return
  }
  const done = exited(proc)
  const result = await Promise.race([
    done.then(() => true),
    sleep(graceMs).then(() => false),
  ])
  if (!result) {
    try {
      proc.kill("SIGKILL")
    } catch {
      /* gone */
    }
    await done
  }
}

export function pauseProcess(entry: RegisteredProcess): void {
  if (entry.stopped || entry.proc.exitCode !== null) return
  entry.proc.kill("SIGSTOP")
  entry.stopped = true
}

export function resumeProcess(entry: RegisteredProcess): void {
  if (!entry.stopped || entry.proc.exitCode !== null) return
  entry.proc.kill("SIGCONT")
  entry.stopped = false
}

export interface SpawnOptions {
  kind: string
  /** nice level; ffmpeg is started through `nice -n N`. */
  nice?: number
  stdio?: StdioOptions
}

/** Long-lived ffmpeg (HLS runs, clips, peaks). Caller owns stdout/stderr. */
export function spawnFfmpeg(
  args: string[],
  opts: SpawnOptions
): RegisteredProcess {
  const useNice = opts.nice !== undefined && opts.nice > 0
  const file = useNice ? "nice" : config.ffmpegPath
  const argv = useNice
    ? ["-n", String(opts.nice), config.ffmpegPath, ...args]
    : args
  logger.debug({ kind: opts.kind, cmd: [file, ...argv].join(" ") }, "spawn")
  const proc = spawn(file, argv, {
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  return processes.register(proc, opts.kind)
}

export interface RunResult {
  stdout: Uint8Array
  stderr: string
  exitCode: number
  timedOut: boolean
}

/** Short-lived ffmpeg/ffprobe with a timeout and output cap. Never throws on non-zero exit. */
export function runTool(
  file: string,
  args: string[],
  opts: { kind: string; timeoutMs: number; maxBuffer?: number; nice?: number }
): Promise<RunResult> {
  const useNice = opts.nice !== undefined && opts.nice > 0
  const cmd = useNice ? "nice" : file
  const argv = useNice ? ["-n", String(opts.nice), file, ...args] : args
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024
  logger.debug({ kind: opts.kind, cmd: [cmd, ...argv].join(" ") }, "run")
  return new Promise((resolve) => {
    const proc = spawn(cmd, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const entry = processes.register(proc, opts.kind)
    const out: Buffer[] = []
    let outLen = 0
    const err: string[] = []
    let timedOut = false
    let done = false
    const finish = (result: RunResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      void killProcess(entry, 1000)
    }, opts.timeoutMs)
    proc.stdout?.on("data", (c: Buffer) => {
      if (outLen + c.length > maxBuffer) {
        err.push("output exceeded the buffer limit")
        void killProcess(entry, 500)
        return
      }
      out.push(c)
      outLen += c.length
    })
    proc.stderr?.on("data", (c: Buffer) => {
      err.push(c.toString("utf8"))
      if (err.length > 400) err.shift()
    })
    proc.on("error", (e) =>
      finish({
        stdout: new Uint8Array(0),
        stderr: e.message,
        exitCode: -1,
        timedOut,
      })
    )
    proc.on("close", (code) =>
      finish({
        stdout: Buffer.concat(out),
        stderr: err.join(""),
        exitCode: code ?? -1,
        timedOut,
      })
    )
  })
}

export const runFfmpeg = (
  args: string[],
  opts: { kind: string; timeoutMs: number; maxBuffer?: number; nice?: number }
) => runTool(config.ffmpegPath, args, opts)

export const runFfprobe = (
  args: string[],
  opts: { kind: string; timeoutMs: number }
) => runTool(config.ffprobePath, args, opts)

/** Parses one `-progress pipe:1` line ("out_time_us=1234"). */
export function parseProgressLine(
  line: string
): { key: string; value: string } | null {
  const i = line.indexOf("=")
  if (i <= 0) return null
  return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }
}

/** Splits a stream of text into lines, calling `onLine` for each complete line. */
export function lineSplitter(
  onLine: (line: string) => void
): (chunk: Buffer | string) => void {
  let buf = ""
  return (chunk) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl).replace(/\r$/, ""))
      buf = buf.slice(nl + 1)
    }
  }
}

export function lastLines(text: string, n = 8): string {
  return text.trim().split("\n").slice(-n).join("\n")
}

export interface FfmpegCapabilities {
  version: string
  zscale: boolean
  tonemap: boolean
  bwdif: boolean
  libx264: boolean
  aac: boolean
}

export async function detectCapabilities(): Promise<FfmpegCapabilities> {
  const version = await runFfmpeg(["-hide_banner", "-version"], {
    kind: "caps",
    timeoutMs: 15_000,
  })
  const filters = await runFfmpeg(["-hide_banner", "-filters"], {
    kind: "caps",
    timeoutMs: 15_000,
  })
  const encoders = await runFfmpeg(["-hide_banner", "-encoders"], {
    kind: "caps",
    timeoutMs: 15_000,
  })
  const versionText = Buffer.from(version.stdout).toString("utf8")
  const filterText = Buffer.from(filters.stdout).toString("utf8")
  const encoderText = Buffer.from(encoders.stdout).toString("utf8")
  const hasFilter = (name: string) =>
    new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(filterText)
  const hasEncoder = (name: string) =>
    new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(encoderText)
  const m = /ffmpeg version (\S+)/.exec(versionText)
  if (version.exitCode !== 0 || !m) {
    throw new Error(
      `ffmpeg is not runnable (${config.ffmpegPath}): ${lastLines(version.stderr, 3) || "no output"}`
    )
  }
  return {
    version: m[1]!,
    zscale: hasFilter("zscale"),
    tonemap: hasFilter("tonemap"),
    bwdif: hasFilter("bwdif"),
    libx264: hasEncoder("libx264"),
    aac: hasEncoder("aac"),
  }
}

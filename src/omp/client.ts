// Spawns `omp --mode rpc` and exposes request/response correlation plus an
// event stream. See ARCHITECTURE.md, "OMP RPC contract".

import { spawn } from "node:child_process"
import { basename } from "node:path"
import { encodeFrame, RpcFrameDecoder } from "./frames.ts"
import type { OmpClient, OmpEvent, OmpEventHandler, OmpReady, OmpResponse, OmpStartOptions } from "./types.ts"

const DEFAULT_TIMEOUT_MS = 120_000
const NEGOTIATE_TIMEOUT_MS = 5_000
const CLOSE_GRACE_MS = 3_000

export interface OmpClientOptions extends OmpStartOptions {
  /** Per-command response timeout. Defaults to 120s. */
  timeoutMs?: number
}

interface Pending {
  resolve: (response: OmpResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export async function startOmp(options: OmpClientOptions): Promise<OmpClient> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const command = options.command ?? "omp"
  const ompFlags = ["--mode", "rpc"]
  if (options.sessionDir) ompFlags.push("--session-dir", options.sessionDir)
  if (options.resume && options.sessionDir) ompFlags.push("--continue")
  const extra = options.args ?? []
  // A Node executable running a JavaScript entrypoint (tests use one in place
  // of the real omp binary) rejects unknown options placed before its script,
  // so give it the script first and the omp flags after.
  const args = /^node(\.exe)?$/i.test(basename(command))
    ? ["--", ...extra, ...ompFlags]
    : [...ompFlags, ...extra]

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  })

  const decoder = new RpcFrameDecoder()
  const pending = new Map<string, Pending>()
  const handlers = new Set<OmpEventHandler>()
  let idCounter = 0
  let closed = false
  let readySettled = false
  let exitSettled = false

  let resolveReady!: (ready: OmpReady) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<OmpReady>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  let resolveExit!: (info: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExit = resolve
  })

  const settleReady = (settle: () => void) => {
    if (readySettled) return
    readySettled = true
    settle()
  }

  const failPending = (error: Error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      pending.delete(id)
    }
  }

  const writeFrame = (frame: Record<string, unknown>): Promise<void> =>
    new Promise((resolve, reject) => {
      child.stdin.write(encodeFrame(frame), (error) => (error ? reject(error) : resolve()))
    })

  const request = (frame: Record<string, unknown> & { type: string }, ms: number): Promise<OmpResponse> => {
    if (closed || !child.stdin.writable) return Promise.reject(new Error("omp client is closed"))
    const id = typeof frame.id === "string" ? frame.id : `c${++idCounter}`
    return new Promise<OmpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`omp command "${frame.type}" timed out after ${ms}ms`))
      }, ms)
      timer.unref()
      pending.set(id, { resolve, reject, timer })
      writeFrame({ ...frame, id }).catch((error: Error) => {
        const entry = pending.get(id)
        if (entry) {
          pending.delete(id)
          clearTimeout(entry.timer)
          reject(error)
        }
      })
    })
  }

  const negotiate = async (readyFrame: OmpReady) => {
    const supported = readyFrame.supportedProtocolVersions
    if (Array.isArray(supported) && supported.includes(2)) {
      try {
        await request({ type: "negotiate_protocol", protocolVersion: 2 }, NEGOTIATE_TIMEOUT_MS)
      } catch {
        // Negotiation is best effort: callers should still proceed.
      }
    }
    settleReady(() => resolveReady(readyFrame))
  }

  const dispatch = (frame: unknown) => {
    if (typeof frame !== "object" || frame === null) return
    const type = (frame as { type?: unknown }).type
    if (type === "ready") {
      void negotiate(frame as OmpReady)
      return
    }
    if (type === "response") {
      const response = frame as OmpResponse
      const entry = response.id !== undefined ? pending.get(response.id) : undefined
      if (entry && response.id !== undefined) {
        pending.delete(response.id)
        clearTimeout(entry.timer)
        entry.resolve(response)
      }
      return
    }
    for (const handler of handlers) {
      try {
        handler(frame as OmpEvent)
      } catch (error) {
        if (process.env.OPENPI_DEBUG) process.stderr.write(`openpi: event handler error: ${String(error)}\n`)
      }
    }
  }

  child.stdout.on("data", (chunk: Buffer) => {
    let frames: unknown[]
    try {
      frames = decoder.push(chunk)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      failPending(failure)
      settleReady(() => rejectReady(failure))
      return
    }
    for (const frame of frames) dispatch(frame)
  })

  // Always drain stderr so a chatty child cannot block on a full pipe.
  child.stderr.on("data", (chunk: Buffer) => {
    if (process.env.OPENPI_DEBUG) process.stderr.write(chunk)
  })

  child.on("error", (error) => {
    failPending(error)
    settleReady(() => rejectReady(error))
    if (!exitSettled) {
      exitSettled = true
      resolveExit({ code: null, signal: null })
    }
  })

  child.on("close", (code, signal) => {
    closed = true
    if (!exitSettled) {
      exitSettled = true
      resolveExit({ code, signal })
    }
    failPending(new Error(`omp exited (code=${code ?? "null"}, signal=${signal ?? "null"})`))
    settleReady(() => rejectReady(new Error("omp exited before ready")))
  })

  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      closed = true
      if (child.stdin.writable) child.stdin.end()
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, CLOSE_GRACE_MS)
      force.unref()
      try {
        await exited
      } finally {
        clearTimeout(force)
      }
    })()
    return closing
  }

  const onEvent = (handler: OmpEventHandler): (() => void) => {
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  }

  const send = (frame: Record<string, unknown> & { type: string }): Promise<OmpResponse> => request(frame, timeoutMs)

  return { ready, send, onEvent, exited, close }
}

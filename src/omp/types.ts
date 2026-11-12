// Shared types for the OMP RPC boundary. Locked: client.ts and map.ts both
// depend on these, and manager.ts consumes them.

export interface OmpReady {
  type: "ready"
  protocolVersion: number
  supportedProtocolVersions: number[]
  maxFrameBytes: number
  maxReassembledFrameBytes: number
  supportsBashExcludeFromContext?: boolean
}

export interface OmpResponse {
  type: "response"
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
  code?: string
}

// Every non-response stdout frame other than ready/rpc_chunk: agent events,
// prompt_result, session_settled, extension_ui_request, notices, and so on.
export interface OmpEvent {
  type: string
  [key: string]: unknown
}

export type OmpFrame = OmpReady | OmpResponse | OmpEvent

export interface OmpStartOptions {
  /** Executable, default "omp". */
  command?: string
  /** Extra args after `--mode rpc`. */
  args?: string[]
  /** Working directory for the child (the project root). */
  cwd: string
  /** Per-session directory so OMP keeps conversations apart. */
  sessionDir?: string
  env?: Record<string, string | undefined>
}

export type OmpEventHandler = (event: OmpEvent) => void

export interface OmpClient {
  readonly ready: Promise<OmpReady>
  /** Send a command and resolve on its correlated response. */
  send<T = unknown>(command: Record<string, unknown> & { type: string }): Promise<OmpResponse>
  /** Subscribe to agent/streaming events. */
  onEvent(handler: OmpEventHandler): () => void
  /** Resolves when the child exits. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  /** Graceful shutdown: close stdin, wait, then kill. */
  close(): Promise<void>
}

export interface OmpStart {
  (options: OmpStartOptions): Promise<OmpClient>
}

// OpenCode v2 public event envelope, as sent over GET /api/event.
export interface SessionEventEnvelope {
  id: string
  created: number
  type: string
  location?: { directory: string }
  data: Record<string, unknown>
  durable?: { aggregateID: string; seq: number; version: number }
}

import { join } from "node:path"
import { startOmp } from "../omp/client.ts"
import { EventTranslator } from "../omp/map.ts"
import type { OmpClient, OmpEvent, SessionEventEnvelope } from "../omp/types.ts"
import { materializeAttachments, repairStoredMessages } from "./attachments.ts"
import { Feed } from "./feed.ts"
import { eventID, messageID, sessionID } from "./ids.ts"
import { Store } from "./store.ts"
import { generateTitle as defaultGenerateTitle, type TitleGenerator } from "./title.ts"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface SessionInfo {
  id: string
  parentID?: string
  projectID: string
  agent?: string
  model?: ModelRef
  cost: number
  tokens: Tokens
  time: { created: number; updated: number; idle?: number }
  title?: string
  location: { directory: string }
  metadata?: Record<string, unknown>
  permissions?: unknown
  outcome?: "succeeded" | "failed" | "interrupted"
}

export interface ManagerOptions {
  feed: Feed
  store: Store
  /** Root of the project sessions run against. */
  directory: string
  /** Where per-session OMP conversation dirs live. */
  dataDir: string
  /** OMP executable, default "omp". */
  command?: string
  args?: string[]
  /** Session title generator; defaults to a short out-of-band OMP call. */
  generateTitle?: TitleGenerator
}

interface Runtime {
  info: SessionInfo
  messages: Record<string, unknown>[]
  omp?: OmpClient
  translator?: EventTranslator
  unsubscribe?: () => void
  engineError?: string
  closing?: boolean
  seq?: number
  children?: Map<string, Runtime>
  linkedTools?: Set<string>
  titleRequested?: boolean
}

const emptyTokens = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

// Owns the mapping between one OpenCode session and one OMP RPC process.
export class Manager {
  #feed: Feed
  #store: Store
  #directory: string
  #dataDir: string
  #command: string
  #args: string[]
  #runtimes = new Map<string, Runtime>()
  #catalog?: Promise<OmpClient>
  #generateTitle: TitleGenerator

  constructor(options: ManagerOptions) {
    this.#feed = options.feed
    this.#store = options.store
    this.#directory = options.directory
    this.#dataDir = options.dataDir
    this.#command = options.command ?? "omp"
    this.#args = options.args ?? []
    this.#generateTitle = options.generateTitle ?? defaultGenerateTitle
  }

  // ---- sessions -----------------------------------------------------------

  createSession(input: {
    id?: string
    directory?: string
    location?: { directory?: string }
    parentID?: string
    agent?: string
    model?: ModelRef
    title?: string
    metadata?: Record<string, unknown>
    permissions?: unknown
  } = {}): SessionInfo {
    const now = Date.now()
    const directory = input.directory ?? input.location?.directory ?? this.#directory
    const info: SessionInfo = {
      id: input.id ?? sessionID(),
      projectID: projectID(directory),
      agent: input.agent ?? "build",
      cost: 0,
      tokens: emptyTokens(),
      time: { created: now, updated: now },
      location: { directory },
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
    }
    if (this.#runtimes.has(info.id)) return this.#runtimes.get(info.id)!.info
    const rt: Runtime = { info, messages: [] }
    this.#runtimes.set(info.id, rt)
    this.#store.save(info.id, { info, messages: [] })
    this.#publish(rt, "session.created", {
      sessionID: info.id,
      projectID: info.projectID,
      location: info.location,
      slug: "",
      version: "openpi",
      ...(info.model ? { model: info.model } : {}),
      ...(info.agent ? { agent: info.agent } : {}),
      ...(info.title ? { title: info.title } : {}),
    }, 1)
    return info
  }

  listSessions(): SessionInfo[] {
    return this.#store.list().map((row) => row.record.info as unknown as SessionInfo)
  }

  getSession(id: string): SessionInfo | undefined {
    return this.#runtime(id)?.info
  }

  messages(id: string): Record<string, unknown>[] | undefined {
    return this.#runtime(id)?.messages
  }

  renameSession(id: string, title: string): SessionInfo | undefined {
    const rt = this.#runtime(id)
    if (!rt) return undefined
    rt.info.title = title
    rt.info.time.updated = Date.now()
    this.#persist(rt)
    this.#publish(rt, "session.renamed", { sessionID: id, title }, 1)
    return rt.info
  }

  async deleteSession(id: string): Promise<boolean> {
    const rt = this.#runtime(id)
    if (!rt) return false
    await this.#stopEngine(rt)
    this.#runtimes.delete(id)
    this.#store.delete(id)
    this.#publish(rt, "session.deleted", { sessionID: id }, 2)
    return true
  }

  // ---- execution ----------------------------------------------------------

  async prompt(
    id: string,
    body: {
      id?: string
      text: string
      files?: unknown[]
      agents?: unknown[]
      skills?: unknown[]
      metadata?: Record<string, unknown>
      delivery?: "steer" | "queue"
    },
  ): Promise<Record<string, unknown> | undefined> {
    const rt = this.#runtime(id)
    if (!rt) return undefined
    await this.#ensureEngine(rt)

    const inboxID = body.id ?? messageID()
    const created = Date.now()
    // Resolve attachment URIs once: the stored/emitted message needs the
    // UI's `{ data, mime, source }` shape, and OMP needs the images.
    const attachments = await materializeAttachments(body.files ?? [], rt.info.location.directory)
    const payload: Record<string, unknown> = {
      text: body.text,
      ...(attachments.files.length > 0 ? { files: attachments.files } : {}),
      ...(body.agents ? { agents: body.agents } : {}),
      ...(body.skills ? { skills: body.skills } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
    }
    const delivery = body.delivery ?? "queue"
    const item = { type: "user", payload, delivery }

    rt.messages.push({
      id: inboxID,
      type: "user",
      time: { created },
      text: body.text,
      files: attachments.files,
      agents: body.agents ?? [],
      skills: body.skills ?? [],
    })
    this.#publish(rt, "session.inbox.enqueued", { sessionID: id, inboxID, item }, 1)
    this.#persist(rt)
    this.#publish(rt, "session.inbox.delivered", { sessionID: id, inboxID }, 1)
    this.#maybeGenerateTitle(rt, body.text)

    const streamingBehavior = body.delivery === "steer" ? "steer" : "followUp"
    void rt.omp!
      .send({
        type: "prompt",
        message: body.text + attachments.context,
        ...(attachments.images.length > 0 ? { images: attachments.images } : {}),
        streamingBehavior,
      })
      .then((response) => {
        if (!response.success) this.#engineFailure(rt, new Error(response.error ?? "prompt rejected"))
      })
      .catch((error) => this.#engineFailure(rt, error))

    return { id: inboxID, sessionID: id, time: { created }, type: "user", payload, delivery }
  }

  async interrupt(id: string): Promise<void> {
    const rt = this.#runtime(id)
    if (!rt) return
    if (rt.omp && rt.translator) {
      for (const envelope of rt.translator.interrupted()) this.#emit(rt, envelope)
      const stopped = await rt.omp.send({ type: "abort" }).then(() => true).catch(() => false)
      if (stopped) return
      rt.omp = undefined
    }
    // No live engine to abort (a shutdown left the turn open): close it out so
    // the UI leaves the running state instead of offering a stop that cannot work.
    this.#settleOpenTurn(rt, "shutdown")
  }

  // A turn cut off by a shutdown has no engine behind it. Append an interrupted
  // idle so the transcript (and any client that reloads it) stops at a turn end.
  #settleOpenTurn(rt: Runtime, reason: string): void {
    const last = rt.messages[rt.messages.length - 1]
    if (!last || last.type === "idle") return
    this.#emit(rt, {
      id: eventID(),
      created: Date.now(),
      type: "session.execution.interrupted",
      location: rt.info.location,
      data: { sessionID: rt.info.id, reason },
      durable: { aggregateID: rt.info.id, seq: nextSeq(rt), version: 1 },
    })
  }

  cancelInbox(id: string, inboxID: string): boolean {
    const rt = this.#runtime(id)
    if (!rt) return false
    const index = rt.messages.findIndex((message) => message.id === inboxID && message.type === "user")
    if (index !== -1) rt.messages.splice(index, 1)
    this.#persist(rt)
    this.#publish(rt, "session.inbox.cancelled", { sessionID: id, inboxID }, 1)
    return index !== -1
  }

  async setModel(id: string, ref: ModelRef): Promise<void> {
    const rt = this.#runtime(id)
    if (!rt) return
    rt.info.model = ref
    rt.info.time.updated = Date.now()
    this.#persist(rt)
    this.#publish(rt, "session.model.selected", { sessionID: id, model: ref }, 1)
    if (rt.omp) {
      await rt.omp.send({ type: "set_model", provider: ref.providerID, modelId: ref.id }).catch(() => undefined)
      await this.#applyVariant(rt)
    }
  }

  // The UI's effort menu sends a model variant; OMP's equivalent is the
  // thinking level, whose names match the variants we advertise.
  async #applyVariant(rt: Runtime): Promise<void> {
    const variant = rt.info.model?.variant
    if (!rt.omp || !variant || variant === "default") return
    await rt.omp.send({ type: "set_thinking_level", level: variant }).catch(() => undefined)
  }

  // OMP disables its own title generation in RPC mode, so name the session
  // from its first prompt the way OpenCode does: one short out-of-band call.
  #maybeGenerateTitle(rt: Runtime, text: string): void {
    if (rt.titleRequested || rt.info.title || !text.trim()) return
    rt.titleRequested = true
    // `#args` are RPC-only flags, so the title call runs the bare executable.
    void this.#generateTitle({ command: this.#command, cwd: rt.info.location.directory, text })
      .then((title) => {
        if (title && !rt.info.title) this.renameSession(rt.info.id, title)
        // Nothing to name yet (a greeting); let a later prompt try again.
        else if (!title) rt.titleRequested = false
      })
      .catch(() => undefined)
  }

  async close(): Promise<void> {
    await Promise.all([...this.#runtimes.values()].map((rt) => this.#stopEngine(rt)))
  }

  // ---- catalog ------------------------------------------------------------

  async models(): Promise<Record<string, unknown>[]> {
    const client = await this.#catalogClient()
    const response = await client.send<unknown>({ type: "get_available_models" })
    const data = response.data
    const list = Array.isArray(data) ? data : ((data as { models?: unknown[] } | undefined)?.models ?? [])
    return (list as Record<string, unknown>[]).map((model) => toModelInfo(model))
  }

  async #catalogClient(): Promise<OmpClient> {
    if (!this.#catalog) {
      this.#catalog = startOmp({ command: this.#command, args: this.#args, cwd: this.#directory })
    }
    return this.#catalog
  }

  // ---- engine lifecycle ---------------------------------------------------

  async #ensureEngine(rt: Runtime): Promise<void> {
    if (rt.omp) return
    const sessionDir = join(this.#dataDir, "omp", rt.info.id)
    const omp = await startOmp({
      command: this.#command,
      args: this.#args,
      cwd: rt.info.location.directory,
      sessionDir,
      resume: true,
    })
    rt.omp = omp
    rt.engineError = undefined
    let model = rt.info.model
    if (!model) {
      const state = await omp.send<{ model?: { provider?: string; id?: string } }>({ type: "get_state" }).catch(() => undefined)
      const reported = state?.data?.model
      if (reported?.provider && reported.id) {
        model = { providerID: reported.provider, id: reported.id }
        rt.info.model = model
      }
    }
    rt.translator = new EventTranslator({
      sessionID: rt.info.id,
      directory: rt.info.location.directory,
      projectID: rt.info.projectID,
      agent: rt.info.agent ?? "build",
      model: model ?? { providerID: "unknown", id: "unknown" },
    })
    rt.unsubscribe = omp.onEvent((event) => this.#onEngineEvent(rt, event))
    void omp.exited.then(({ code }) => {
      if (rt.closing) return
      // Drop the dead client so the next prompt starts a fresh engine instead
      // of failing against a closed pipe.
      if (rt.omp === omp) rt.omp = undefined
      this.#engineFailure(rt, new Error(`omp exited (${code})`))
    })
    await omp.send({ type: "set_subagent_subscription", level: "events" }).catch(() => undefined)
    if (rt.info.model) {
      await omp
        .send({ type: "set_model", provider: rt.info.model.providerID, modelId: rt.info.model.id })
        .catch(() => undefined)
      await this.#applyVariant(rt)
    }
  }

  async #stopEngine(rt: Runtime): Promise<void> {
    rt.closing = true
    rt.unsubscribe?.()
    rt.unsubscribe = undefined
    const omp = rt.omp
    rt.omp = undefined
    if (omp) await omp.close().catch(() => undefined)
  }

  #onEngineEvent(rt: Runtime, event: OmpEvent): void {
    if (event.type.startsWith("subagent_")) {
      this.#onSubagentFrame(rt, event)
      return
    }
    if (event.type === "session_info_update" || event.type === "extension_ui_request") {
      this.#onTitleFrame(rt, event)
      return
    }
    if (!rt.translator) return
    const envelopes = rt.translator.translate(event)
    if (process.env.OPENPI_DEBUG) console.log(`[omp] ${event.type} -> ${envelopes.length} event(s)`)
    for (const envelope of envelopes) this.#emit(rt, envelope)
  }

  // OMP names a session either through a state update or, when opted in, a
  // setTitle UI request; both carry the generated title.
  #onTitleFrame(rt: Runtime, event: OmpEvent): void {
    const title =
      event.type === "session_info_update"
        ? event.title
        : event.type === "extension_ui_request" && event.method === "setTitle"
          ? event.title
          : undefined
    if (typeof title === "string" && title.trim() && title !== rt.info.title) this.renameSession(rt.info.id, title.trim())
  }

  // OMP task subagents become OpenCode child sessions (parentID), so the UI's
  // existing subagent surfaces can render them.
  #onSubagentFrame(rt: Runtime, frame: OmpEvent): void {
    const payload = frame.payload as Record<string, unknown> | undefined
    if (!payload) return
    const subagentID = String(payload.id ?? "")
    this.#linkSubagentTool(rt, payload, subagentID)

    if (frame.type === "subagent_progress") {
      this.#childRuntime(rt, String(payload.id ?? ""), payload)
      return
    }

    if (frame.type === "subagent_event") {
      const inner = payload.event as OmpEvent | undefined
      if (!inner?.type) return
      const child = this.#childRuntime(rt, String(payload.id ?? ""), payload)
      if (!child) return
      if (inner.type.startsWith("subagent_")) {
        this.#onSubagentFrame(child, inner)
        return
      }
      for (const envelope of child.translator?.translate(inner) ?? []) this.#emit(child, envelope)
      return
    }

    if (frame.type !== "subagent_lifecycle") return
    const id = String(payload.id ?? "")
    const child = this.#childRuntime(rt, id, payload)
    if (!child) return
    const status = payload.status
    if (status === "started") {
      this.#publish(child, "session.execution.started", {}, 1)
      return
    }
    const outcome = status === "completed" ? "succeeded" : status === "aborted" ? "interrupted" : "failed"
    child.info.outcome = outcome
    child.info.time.idle = Date.now()
    const type =
      outcome === "succeeded"
        ? "session.execution.succeeded"
        : outcome === "interrupted"
          ? "session.execution.interrupted"
          : "session.execution.failed"
    this.#emit(child, {
      id: eventID(),
      created: Date.now(),
      type,
      location: child.info.location,
      data:
        type === "session.execution.failed"
          ? { sessionID: child.id, error: { type: "task", message: "subagent failed" } }
          : type === "session.execution.interrupted"
            ? { sessionID: child.id, reason: "user" }
            : { sessionID: child.id },
      durable: { aggregateID: child.id, seq: nextSeq(child), version: 1 },
    })
  }

  #linkSubagentTool(parent: Runtime, payload: Record<string, unknown>, subagentID: string): void {
    const toolCallId = payload.parentToolCallId
    if (typeof toolCallId !== "string" || !subagentID) return
    parent.linkedTools ??= new Set()
    if (parent.linkedTools.has(toolCallId)) return
    parent.linkedTools.add(toolCallId)
    const envelopes =
      parent.translator?.linkSubagentTool(toolCallId, {
        sessionID: subagentID,
        background: payload.detached === true,
      }) ?? []
    for (const envelope of envelopes) this.#emit(parent, envelope)
    if (envelopes.length > 0) this.#persist(parent)
  }

  #childRuntime(parent: Runtime, id: string, payload: Record<string, unknown>): Runtime | undefined {
    if (!id) return undefined
    parent.children ??= new Map()
    const existing = parent.children.get(id)
    if (existing) return existing
    const now = Date.now()
    const info: SessionInfo = {
      id,
      parentID: parent.info.id,
      projectID: parent.info.projectID,
      agent: typeof payload.agent === "string" ? payload.agent : "task",
      cost: 0,
      tokens: emptyTokens(),
      time: { created: now, updated: now },
      location: parent.info.location,
      ...(typeof payload.description === "string" ? { title: payload.description } : {}),
      ...(parent.info.model ? { model: parent.info.model } : {}),
    }
    const child: Runtime = { info, messages: [] }
    child.translator = new EventTranslator({
      sessionID: id,
      directory: parent.info.location.directory,
      projectID: parent.info.projectID,
      agent: info.agent ?? "task",
      model: parent.info.model ?? { providerID: "unknown", id: "unknown" },
    })
    parent.children.set(id, child)
    this.#runtimes.set(id, child)
    this.#store.save(id, { info, messages: [] })
    this.#publish(
      child,
      "session.created",
      {
        sessionID: id,
        parentID: parent.info.id,
        projectID: info.projectID,
        location: info.location,
        slug: "",
        version: "openpi",
        ...(info.agent ? { agent: info.agent } : {}),
        ...(info.title ? { title: info.title } : {}),
        ...(info.model ? { model: info.model } : {}),
      },
      1,
    )
    return child
  }

  #engineFailure(rt: Runtime, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (rt.engineError === message) return
    rt.engineError = message
    rt.info.outcome = "failed"
    rt.info.time.idle = Date.now()
    this.#emit(rt, {
      id: eventID(),
      created: Date.now(),
      type: "session.execution.failed",
      location: rt.info.location,
      data: { sessionID: rt.info.id, error: { type: "unknown", message } },
      durable: { aggregateID: rt.info.id, seq: nextSeq(rt), version: 1 },
    })
  }

  // ---- projection + publication ------------------------------------------

  #emit(rt: Runtime, envelope: SessionEventEnvelope): void {
    projectIntoMessages(rt, envelope)
    this.#feed.publish(envelope)
    if (envelope.durable) this.#persist(rt)
  }

  #publish(rt: Runtime, type: string, data: Record<string, unknown>, version: number): void {
    this.#emit(rt, {
      id: eventID(),
      created: Date.now(),
      type,
      location: rt.info.location,
      data,
      durable: { aggregateID: rt.info.id, seq: nextSeq(rt), version },
    })
  }

  #persist(rt: Runtime): void {
    rt.info.time.updated = Date.now()
    this.#store.save(rt.info.id, { info: rt.info, messages: rt.messages })
  }

  #runtime(id: string): Runtime | undefined {
    const existing = this.#runtimes.get(id)
    if (existing) return existing
    const record = this.#store.load(id)
    if (!record) return undefined
    const rt: Runtime = { info: record.info as unknown as SessionInfo, messages: record.messages }
    // Transcripts written before attachments were materialized hold raw
    // `{ uri }` files that crash the UI; upgrade them once, in place.
    if (repairStoredMessages(rt.messages, rt.info.location?.directory ?? this.#directory)) {
      this.#store.save(id, { info: rt.info, messages: rt.messages })
    }
    this.#runtimes.set(id, rt)
    // A turn left open by a previous shutdown has no engine behind it.
    this.#settleOpenTurn(rt, "shutdown")
    return rt
  }
}

function nextSeq(rt: Runtime): number {
  const value = rt.seq ?? 0
  rt.seq = value + 1
  return value
}

export function projectID(directory: string): string {
  return createHashHex(directory)
}

function createHashHex(value: string): string {
  // Stable 40-char id, matching the shape opencode uses for project ids.
  let h1 = 0x811c9dc5
  let out = ""
  for (let i = 0; i < value.length; i++) {
    h1 = Math.imul(h1 ^ value.charCodeAt(i), 0x01000193)
    out += (h1 >>> 0).toString(16).padStart(8, "0")
    if (out.length >= 40) break
  }
  return out.slice(0, 40).padEnd(40, "0")
}

// ---- message projection ---------------------------------------------------

function projectIntoMessages(rt: Runtime, envelope: SessionEventEnvelope): void {
  const data = envelope.data as Record<string, any>
  const messages = rt.messages
  const findAssistant = () =>
    messages.find((m) => m.id === data.assistantMessageID && m.type === "assistant") as
      | { content: any[]; [k: string]: unknown }
      | undefined

  switch (envelope.type) {
    case "session.step.started":
      messages.push({
        id: data.assistantMessageID,
        type: "assistant",
        time: { created: envelope.created },
        agent: data.agent,
        model: data.model,
        content: [],
      })
      break
    case "session.text.started": {
      findAssistant()?.content.push({ type: "text", text: "" })
      break
    }
    case "session.text.delta": {
      const content = findAssistant()?.content
      const last = content?.[content.length - 1]
      if (last && last.type === "text") last.text += data.delta
      break
    }
    case "session.text.ended": {
      const content = findAssistant()?.content
      const last = content?.[content.length - 1]
      if (last && last.type === "text") last.text = data.text
      break
    }
    case "session.reasoning.started":
      findAssistant()?.content.push({ type: "reasoning", text: "", time: { created: envelope.created } })
      break
    case "session.reasoning.delta": {
      const content = findAssistant()?.content
      const last = content?.[content.length - 1]
      if (last && last.type === "reasoning") last.text += data.delta
      break
    }
    case "session.reasoning.ended": {
      const content = findAssistant()?.content
      const last = content?.[content.length - 1]
      if (last && last.type === "reasoning") {
        last.text = data.text
        last.time = { ...last.time, completed: envelope.created }
      }
      break
    }
    case "session.tool.input.started":
      findAssistant()?.content.push({
        type: "tool",
        id: data.id,
        name: data.name,
        state: { status: "streaming", input: "" },
        time: { created: envelope.created },
      })
      break
    case "session.tool.input.delta": {
      const tool = findTool(findAssistant(), data.id)
      if (tool && tool.state.status === "streaming") tool.state.input += data.delta
      break
    }
    case "session.tool.input.ended": {
      const tool = findTool(findAssistant(), data.id)
      if (tool && tool.state.status === "streaming") tool.state.input = data.text
      break
    }
    case "session.tool.called": {
      const tool = ensureTool(findAssistant(), data, envelope.created)
      if (tool) {
        if (typeof data.name === "string" && data.name) tool.name = data.name
        tool.state = { status: "running", input: data.input ?? {}, metadata: {} }
      }
      break
    }
    case "session.tool.progress": {
      const tool = findTool(findAssistant(), data.id)
      if (tool)
        tool.state.metadata = { ...(tool.state.metadata ?? {}), ...(data.metadata ?? {}) }
      break
    }
    case "session.tool.success": {
      const tool = ensureTool(findAssistant(), data, envelope.created)
      if (tool)
        tool.state = {
          status: "completed",
          input: tool.state.input ?? {},
          content: data.content,
          metadata: { ...(tool.state.metadata ?? {}), ...(data.metadata ?? {}) },
        }
      break
    }
    case "session.tool.failed": {
      const tool = ensureTool(findAssistant(), data, envelope.created)
      if (tool)
        tool.state = {
          status: "error",
          input: tool.state.input ?? {},
          error: data.error,
          content: data.content,
          metadata: { ...(tool.state.metadata ?? {}) },
        }
      break
    }
    case "session.step.ended": {
      const assistant = findAssistant()
      if (assistant) {
        assistant.finish = data.finish
        assistant.cost = data.cost
        assistant.tokens = data.tokens
        assistant.time = { created: assistant.time?.created ?? envelope.created, completed: envelope.created }
      }
      break
    }
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
      const outcome =
        envelope.type === "session.execution.succeeded"
          ? "succeeded"
          : envelope.type === "session.execution.failed"
            ? "failed"
            : "interrupted"
      rt.info.outcome = outcome
      rt.info.time.idle = envelope.created
      messages.push({
        id: messageID(),
        type: "idle",
        time: { created: envelope.created },
        outcome,
        ...(data.error ? { error: data.error } : {}),
      })
      break
    }
    default:
      break
  }
}

function findTool(assistant: { content: any[] } | undefined, id: unknown): any {
  return assistant?.content.find((item) => item.type === "tool" && item.id === id)
}

// A tool that executes without a preceding streaming input (a custom or MCP
// tool) still gets a message part so it never disappears from the transcript.
function ensureTool(assistant: { content: any[] } | undefined, data: Record<string, any>, created: number): any {
  const existing = findTool(assistant, data.id)
  if (existing) return existing
  if (!assistant || typeof data.id !== "string") return undefined
  const tool = {
    type: "tool",
    id: data.id,
    name: typeof data.name === "string" ? data.name : "tool",
    state: { status: "streaming", input: "" },
    time: { created },
  }
  assistant.content.push(tool)
  return tool
}

// ---- model mapping --------------------------------------------------------

function toModelInfo(model: Record<string, any>): Record<string, unknown> {
  const input: string[] = Array.isArray(model.input) ? model.input : ["text"]
  const cost = model.cost ?? {}
  const efforts: string[] = Array.isArray(model.thinking?.efforts) ? model.thinking.efforts.filter((e: unknown) => typeof e === "string") : []
  return {
    id: model.id,
    modelID: model.id,
    providerID: model.provider,
    type: "chat",
    ...(model.identity?.family ? { family: model.identity.family } : {}),
    name: model.name ?? model.id,
    package: model.api ?? "omp",
    settings: {},
    headers: {},
    capabilities: { tools: true, input, output: ["text"], temperature: false, reasoning: model.reasoning === true },
    variants: efforts.map((id) => ({ id, settings: {} })),
    time: { released: 0 },
    cost: [
      {
        input: cost.input ?? 0,
        output: cost.output ?? 0,
        cache: { read: cost.cacheRead ?? 0, write: cost.cacheWrite ?? 0 },
      },
    ],
    status: "active",
    enabled: true,
    limit: { context: model.contextWindow ?? 0, output: model.maxTokens ?? 0 },
  }
}

export { toModelInfo }

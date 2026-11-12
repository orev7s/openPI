// EventTranslator: maps OMP agent events onto the OpenCode v2 session event
// envelope. It is stateful across calls: the caller feeds every OMP event for a
// session and receives the durable/ephemeral envelopes to broadcast.

import type { OmpEvent, SessionEventEnvelope } from "./types.ts"

export interface TranslatorOptions {
  sessionID: string
  directory: string
  projectID: string
  agent: string
  model: { providerID: string; id: string; variant?: string }
}

// Monotonic-ish base36 suffix: wall clock plus a counter so IDs created in the
// same millisecond stay distinct.
let idCounter = 0
function ascending(): string {
  idCounter = (idCounter + 1) % 1296
  return Date.now().toString(36) + idCounter.toString(36).padStart(2, "0")
}

export function createEventID(): string {
  return `evt_${ascending()}`
}

export function createMessageID(): string {
  return `msg_${ascending()}`
}

const DUPLICATE_VERSION: Record<string, number> = {
  "session.tool.success": 2,
  "session.tool.failed": 2,
}

function mapFinish(reason: unknown): string {
  switch (reason) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "toolUse":
      return "tool-calls"
    case "error":
      return "error"
    default:
      return "unknown"
  }
}

// OpenCode tool content is a non-empty array of text blocks. OMP produces text
// and image blocks; images are dropped, and an empty result still yields one
// block so the durable event stays schema-valid.
function toTextContent(result: unknown): { type: "text"; text: string }[] {
  const content = (result as { content?: unknown } | null)?.content
  const blocks: { type: "text"; text: string }[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      const item = block as { type?: unknown; text?: unknown }
      if (item?.type === "text" && typeof item.text === "string") blocks.push({ type: "text", text: item.text })
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" })
  return blocks
}

function textOf(result: unknown): string {
  return toTextContent(result)
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n")
}

// OMP tool names differ from the ones the OpenCode UI renders specially.
const TOOL_NAME_MAP: Record<string, string> = { bash: "shell", task: "subagent" }

function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name
}

interface ToolCallRef {
  id: string
  name: string
  arguments: unknown
}

export class EventTranslator {
  private readonly sessionID: string
  private readonly directory: string
  private readonly agent: string
  private readonly model: { providerID: string; id: string; variant?: string }
  private seqCounter = 0
  private assistantID: string | undefined
  private textOrdinal = 0
  private reasoningOrdinal = 0
  private readonly textOrdByIndex = new Map<number, number>()
  private readonly reasoningOrdByIndex = new Map<number, number>()
  private readonly toolCalls = new Map<string, { name: string; input: string; args: unknown }>()
  private readonly indexToCallID = new Map<number, string>()
  private readonly toolAssistant = new Map<string, string>()

  constructor(opts: TranslatorOptions) {
    this.sessionID = opts.sessionID
    this.directory = opts.directory
    this.agent = opts.agent
    this.model = opts.model
  }

  /** Next durable sequence number; the caller persists this to resume. */
  seq(): number {
    return this.seqCounter
  }

  assistantMessageID(): string | undefined {
    return this.assistantID
  }

  currentModel(): { providerID: string; id: string; variant?: string } {
    return this.model
  }

  translate(event: OmpEvent): SessionEventEnvelope[] {
    switch (event.type) {
      case "agent_start":
        return [this.durable("session.execution.started", {})]
      case "message_start":
        return this.onMessageStart(event)
      case "message_update":
        return this.onMessageUpdate(event)
      case "message_end":
        return this.onMessageEnd(event)
      case "tool_execution_start":
        return this.onToolExecutionStart(event)
      case "tool_execution_update":
        return this.onToolExecutionUpdate(event)
      case "tool_execution_end":
        return this.onToolExecutionEnd(event)
      case "agent_end":
        return event.yielded === false ? [] : [this.durable("session.execution.succeeded", {})]
      case "notice":
        return this.onNotice(event)
      default:
        return []
    }
  }

  /** Emitted when the caller issues an abort. */
  interrupted(): SessionEventEnvelope[] {
    return [this.durable("session.execution.interrupted", { reason: "user" })]
  }

  /** Links a running subagent tool call to its child session for the UI. */
  linkSubagentTool(toolCallId: string, info: { sessionID: string; background?: boolean }): SessionEventEnvelope[] {
    const assistantID = this.toolAssistant.get(toolCallId) ?? this.assistantID
    if (!assistantID) return []
    return [
      this.ephemeral("session.tool.progress", {
        assistantMessageID: assistantID,
        id: toolCallId,
        metadata: { sessionID: info.sessionID, ...(info.background ? { background: true } : {}) },
      }),
    ]
  }

  private durable(type: string, data: Record<string, unknown>): SessionEventEnvelope {
    const seq = this.seqCounter++
    return {
      id: createEventID(),
      created: Date.now(),
      type,
      location: { directory: this.directory },
      data: { sessionID: this.sessionID, ...data },
      durable: { aggregateID: this.sessionID, seq, version: DUPLICATE_VERSION[type] ?? 1 },
    }
  }

  private ephemeral(type: string, data: Record<string, unknown>): SessionEventEnvelope {
    return {
      id: createEventID(),
      created: Date.now(),
      type,
      location: { directory: this.directory },
      data: { sessionID: this.sessionID, ...data },
    }
  }

  private onMessageStart(event: OmpEvent): SessionEventEnvelope[] {
    const message = event.message as { role?: unknown; timestamp?: unknown } | undefined
    if (!message || message.role !== "assistant") return []
    this.assistantID = createMessageID()
    this.textOrdinal = 0
    this.reasoningOrdinal = 0
    this.textOrdByIndex.clear()
    this.reasoningOrdByIndex.clear()
    this.indexToCallID.clear()
    const started = typeof message.timestamp === "number" ? message.timestamp : Date.now()
    return [
      this.durable("session.step.started", {
        assistantMessageID: this.assistantID,
        agent: this.agent,
        model: this.model,
        started,
      }),
    ]
  }

  private onMessageUpdate(event: OmpEvent): SessionEventEnvelope[] {
    const assistantID = this.assistantID
    if (!assistantID) return []
    const ame = event.assistantMessageEvent as
      | { type?: string; contentIndex?: number; delta?: unknown; content?: unknown; toolCall?: unknown; partial?: unknown }
      | undefined
    if (!ame) return []
    const index = typeof ame.contentIndex === "number" ? ame.contentIndex : -1

    switch (ame.type) {
      case "text_start":
        return [
          this.durable("session.text.started", { assistantMessageID: assistantID, ordinal: this.textOrdinalFor(index) }),
        ]
      case "text_delta":
        return [
          this.ephemeral("session.text.delta", {
            assistantMessageID: assistantID,
            ordinal: this.textOrdinalFor(index),
            delta: typeof ame.delta === "string" ? ame.delta : "",
          }),
        ]
      case "text_end":
        return [
          this.durable("session.text.ended", {
            assistantMessageID: assistantID,
            ordinal: this.textOrdinalFor(index),
            text: typeof ame.content === "string" ? ame.content : "",
          }),
        ]
      case "thinking_start":
        return [
          this.durable("session.reasoning.started", {
            assistantMessageID: assistantID,
            ordinal: this.reasoningOrdinalFor(index),
          }),
        ]
      case "thinking_delta":
        return [
          this.ephemeral("session.reasoning.delta", {
            assistantMessageID: assistantID,
            ordinal: this.reasoningOrdinalFor(index),
            delta: typeof ame.delta === "string" ? ame.delta : "",
          }),
        ]
      case "thinking_end":
        return [
          this.durable("session.reasoning.ended", {
            assistantMessageID: assistantID,
            ordinal: this.reasoningOrdinalFor(index),
            text: typeof ame.content === "string" ? ame.content : "",
          }),
        ]
      case "toolcall_start": {
        const call = this.pickToolCall(ame, index)
        if (!call) return []
        this.indexToCallID.set(index, call.id)
        this.toolAssistant.set(call.id, assistantID)
        this.toolCalls.set(call.id, { name: call.name, input: "", args: call.arguments })
        return [
          this.durable("session.tool.input.started", {
            assistantMessageID: assistantID,
            id: call.id,
            name: normalizeToolName(call.name),
          }),
        ]
      }
      case "toolcall_delta": {
        const id = this.indexToCallID.get(index) ?? this.pickToolCall(ame, index)?.id
        if (!id) return []
        const entry = this.toolCalls.get(id)
        if (entry && typeof ame.delta === "string") entry.input += ame.delta
        return [
          this.ephemeral("session.tool.input.delta", {
            assistantMessageID: assistantID,
            id,
            delta: typeof ame.delta === "string" ? ame.delta : "",
          }),
        ]
      }
      case "toolcall_end": {
        const call = this.pickToolCall(ame, index)
        const id = this.indexToCallID.get(index) ?? call?.id
        if (!id) return []
        const entry = this.toolCalls.get(id)
        const text =
          entry && entry.input.length > 0 ? entry.input : JSON.stringify(call?.arguments ?? entry?.args ?? {})
        return [
          this.durable("session.tool.input.ended", { assistantMessageID: assistantID, id, text }),
        ]
      }
      default:
        return []
    }
  }

  private onMessageEnd(event: OmpEvent): SessionEventEnvelope[] {
    const assistantID = this.assistantID
    const message = event.message as
      | { role?: unknown; stopReason?: unknown; usage?: Record<string, unknown> }
      | undefined
    if (!assistantID || !message || message.role !== "assistant") return []
    const usage = message.usage ?? {}
    const cost = usage.cost as { total?: unknown } | undefined
    return [
      this.durable("session.step.ended", {
        assistantMessageID: assistantID,
        finish: mapFinish(message.stopReason),
        cost: typeof cost?.total === "number" ? cost.total : 0,
        tokens: {
          input: typeof usage.input === "number" ? usage.input : 0,
          output: typeof usage.output === "number" ? usage.output : 0,
          reasoning: typeof usage.reasoning === "number" ? usage.reasoning : 0,
          cache: {
            read: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
            write: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
          },
        },
      }),
    ]
  }

  private onToolExecutionStart(event: OmpEvent): SessionEventEnvelope[] {
    const assistantID = this.assistantID
    const id = event.toolCallId
    if (!assistantID || typeof id !== "string") return []
    const name = normalizeToolName(typeof event.toolName === "string" ? event.toolName : "")
    const input = asRecord(event.args)
    this.toolAssistant.set(id, assistantID)
    this.toolCalls.set(id, { name, input: "", args: input })
    return [
      this.durable("session.tool.called", {
        assistantMessageID: assistantID,
        id,
        name,
        input,
        executed: true,
      }),
    ]
  }

  private onToolExecutionUpdate(event: OmpEvent): SessionEventEnvelope[] {
    const assistantID = this.assistantID
    const id = event.toolCallId
    if (!assistantID || typeof id !== "string") return []
    return [
      this.ephemeral("session.tool.progress", {
        assistantMessageID: assistantID,
        id,
        metadata: asRecord(event.partialResult),
      }),
    ]
  }

  private onToolExecutionEnd(event: OmpEvent): SessionEventEnvelope[] {
    const assistantID = this.assistantID
    const id = event.toolCallId
    if (!assistantID || typeof id !== "string") return []
    const result = event.result
    const content = toTextContent(result)
    if (event.isError === true) {
      return [
        this.durable("session.tool.failed", {
          assistantMessageID: assistantID,
          id,
          error: { type: "tool-error", message: textOf(result) || "Tool execution failed" },
          content,
          executed: true,
        }),
      ]
    }
    const details = asRecord((result as { details?: unknown } | null)?.details)
    return [
      this.durable("session.tool.success", {
        assistantMessageID: assistantID,
        id,
        content,
        ...(Object.keys(details).length > 0 ? { metadata: details } : {}),
        executed: true,
      }),
    ]
  }

  private onNotice(event: OmpEvent): SessionEventEnvelope[] {
    if (event.level !== "error") return []
    const message = typeof event.message === "string" ? event.message : "Agent error"
    const type = typeof event.source === "string" ? event.source : "unknown"
    return [this.durable("session.execution.failed", { error: { type, message } })]
  }

  private textOrdinalFor(index: number): number {
    const existing = this.textOrdByIndex.get(index)
    if (existing !== undefined) return existing
    const ordinal = this.textOrdinal++
    this.textOrdByIndex.set(index, ordinal)
    return ordinal
  }

  private reasoningOrdinalFor(index: number): number {
    const existing = this.reasoningOrdByIndex.get(index)
    if (existing !== undefined) return existing
    const ordinal = this.reasoningOrdinal++
    this.reasoningOrdByIndex.set(index, ordinal)
    return ordinal
  }

  private pickToolCall(ame: { contentIndex?: number; toolCall?: unknown; partial?: unknown }, index: number): ToolCallRef | undefined {
    if (isToolCall(ame.toolCall)) return ame.toolCall
    const content = (ame.partial as { content?: unknown } | undefined)?.content
    if (Array.isArray(content)) {
      if (isToolCall(content[index])) return content[index]
      for (let i = content.length - 1; i >= 0; i--) {
        if (isToolCall(content[i])) return content[i]
      }
    }
    return undefined
  }
}

function isToolCall(value: unknown): value is ToolCallRef {
  const call = value as ToolCallRef | undefined
  return !!call && typeof call.id === "string" && typeof call.name === "string"
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

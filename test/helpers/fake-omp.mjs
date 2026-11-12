#!/usr/bin/env node
// Minimal stand-in for `omp --mode rpc`: JSONL in, JSONL out. Used by the
// omp-client tests.

import readline from "node:readline"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\n")

let negotiatedVersion = 1

emit({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
})

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on("line", (line) => {
  if (line.trim() === "") return
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  handle(frame).catch((error) => {
    emit({
      type: "response",
      id: frame?.id,
      command: frame?.type,
      success: false,
      error: String(error?.message ?? error),
    })
  })
})

async function handle(frame) {
  const respond = (data) => emit({ type: "response", id: frame.id, command: frame.type, success: true, data })
  switch (frame.type) {
    case "negotiate_protocol":
      negotiatedVersion = typeof frame.protocolVersion === "number" ? frame.protocolVersion : 1
      respond({ protocolVersion: negotiatedVersion })
      return
    case "get_state":
      respond({
        model: { providerID: "anthropic", id: "claude-fake" },
        isStreaming: false,
        messageCount: 0,
        protocolVersion: negotiatedVersion,
      })
      return
    case "set_model":
      respond({ ok: true })
      return
    case "get_available_models":
      respond({ models: [{ providerID: "anthropic", id: "claude-fake", name: "Claude Fake" }] })
      return
    case "new_session":
    case "open_session":
      respond({ ok: true })
      return
    case "prompt":
      respond({ agentInvoked: true })
      void runPrompt(frame.id)
      return
    case "abort":
      respond({ ok: true })
      emit({ type: "agent_end", yielded: true, aborted: true, reason: "aborted" })
      return
    default:
      emit({ type: "response", id: frame.id, command: frame.type, success: false, error: `unknown command ${frame.type}` })
  }
}

async function runPrompt(id) {
  const text = "Hello fake omp"
  const message = { role: "assistant", content: [] }
  emit({ type: "agent_start" })
  await sleep(2)
  emit({ type: "message_start", message })
  await sleep(2)
  emit({ type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 0 } })
  await sleep(2)
  for (const delta of ["Hello ", "fake ", "omp"]) {
    emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } })
    await sleep(2)
  }
  emit({ type: "message_update", message, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } })
  await sleep(2)
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })
  await sleep(2)
  emit({ type: "agent_end", yielded: true })
  await sleep(2)
  emit({ type: "prompt_result", promptId: id, status: "completed" })
  await sleep(2)
  emit({ type: "session_settled" })
}

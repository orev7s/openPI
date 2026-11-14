#!/usr/bin/env node
// Minimal stand-in for `omp --mode rpc`: JSONL in, JSONL out. Used by the
// omp-client tests.

import readline from "node:readline"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\n")

const argv = process.argv.slice(2)
const scenarioIndex = argv.indexOf("--scenario")
const scenario = scenarioIndex === -1 ? "default" : (argv[scenarioIndex + 1] ?? "default")

let negotiatedVersion = 1

emit({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
})

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

// Scenarios that answer a host round trip park on a waiter until the frame
// they expect arrives (see waitForFrame).
let waiters = []

function waitForFrame(match, ms = 10000) {
  return new Promise((resolve, reject) => {
    const waiter = {
      match,
      resolve: (frame) => {
        clearTimeout(timer)
        resolve(frame)
      },
    }
    const timer = setTimeout(() => {
      waiters = waiters.filter((entry) => entry !== waiter)
      reject(new Error("timed out waiting for a frame from the host"))
    }, ms)
    waiters.push(waiter)
  })
}

input.on("line", (line) => {
  if (line.trim() === "") return
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  waiters = waiters.filter((waiter) => {
    if (!waiter.match(frame)) return true
    waiter.resolve(frame)
    return false
  })
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
        argv: process.argv.slice(2),
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
    case "set_subagent_subscription":
      respond({ level: frame.level })
      return
    case "set_ask_dialog":
      respond({ enabled: frame.enabled === true })
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
  if (scenario === "error") return runErrorPrompt(id)
  if (scenario === "unknown-tool") return runUnknownToolPrompt(id)
  if (scenario === "ask") return runAskPrompt(id)
  if (scenario === "select") return runSelectPrompt(id)
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
  const child = "FitPanther"
  emit({ type: "subagent_lifecycle", payload: { id: child, agent: "task", status: "started", index: 0, description: "child work" } })
  await sleep(2)
  emit({ type: "subagent_event", payload: { id: child, event: { type: "agent_start" } } })
  await sleep(2)
  emit({ type: "subagent_event", payload: { id: child, event: { type: "message_start", message } } })
  await sleep(2)
  emit({ type: "subagent_event", payload: { id: child, event: { type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 0 } } } })
  await sleep(2)
  emit({ type: "subagent_event", payload: { id: child, event: { type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "sub result" } } } })
  await sleep(2)
  emit({ type: "subagent_event", payload: { id: child, event: { type: "message_update", message, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "sub result" } } } })
  await sleep(2)
  emit({ type: "subagent_event", payload: { id: child, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "sub result" }] } } } })
  await sleep(2)
  emit({ type: "subagent_event", payload: { id: child, event: { type: "agent_end", yielded: true } } })
  await sleep(2)
  emit({ type: "subagent_lifecycle", payload: { id: child, agent: "task", status: "completed", index: 0 } })
  await sleep(2)
  emit({ type: "agent_end", yielded: true })
  await sleep(2)
  emit({ type: "prompt_result", promptId: id, status: "completed" })
  await sleep(2)
  emit({ type: "session_settled" })
}

// A model/provider failure ends the run without yielding; only prompt_result
// carries the error.
async function runErrorPrompt(id) {
  const message = { role: "assistant", content: [] }
  emit({ type: "agent_start" })
  await sleep(2)
  emit({ type: "message_start", message })
  await sleep(2)
  emit({ type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 0 } })
  await sleep(2)
  emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "trying" } })
  await sleep(2)
  emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } })
  await sleep(2)
  emit({ type: "agent_end", yielded: true })
  await sleep(2)
  emit({
    type: "prompt_result",
    promptId: id,
    agentInvoked: true,
    status: "error",
    error: { message: "provider exploded", retryable: false },
    sessionSettled: true,
  })
  await sleep(2)
  emit({ type: "session_settled" })
}

// A custom tool that runs without any streamed toolcall_* input.
async function runUnknownToolPrompt(id) {
  const message = { role: "assistant", content: [] }
  emit({ type: "agent_start" })
  await sleep(2)
  emit({ type: "message_start", message })
  await sleep(2)
  emit({ type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 0 } })
  await sleep(2)
  emit({ type: "message_update", message, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ran a tool" } })
  await sleep(2)
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ran a tool" }] } })
  await sleep(2)
  emit({ type: "tool_execution_start", toolCallId: "call_eval", toolName: "eval", args: { language: "py", code: "print(1)" } })
  await sleep(2)
  emit({
    type: "tool_execution_end",
    toolCallId: "call_eval",
    result: { content: [{ type: "text", text: "1" }], details: {} },
    isError: false,
  })
  await sleep(2)
  emit({ type: "agent_end", yielded: true })
  await sleep(2)
  emit({ type: "prompt_result", promptId: id, agentInvoked: true, status: "completed", sessionSettled: true })
  await sleep(2)
  emit({ type: "session_settled" })
}

// The `ask` tool: one extension_ui_request carrying every question, which only
// a host that opted in with set_ask_dialog ever sees. The answer is reported
// back as the tool result so a test can assert what OMP received.
async function runAskPrompt(id) {
  const message = { role: "assistant", content: [] }
  emit({ type: "agent_start" })
  await sleep(2)
  emit({ type: "message_start", message })
  await sleep(2)
  emit({ type: "tool_execution_start", toolCallId: "call_ask", toolName: "ask", args: { html: "<form></form>" } })
  await sleep(2)
  emit({
    type: "extension_ui_request",
    id: "ui_ask_1",
    method: "ask",
    title: "Questions",
    timeout: 30000,
    questions: [
      {
        id: "db",
        question: "Which database?",
        header: "Database",
        options: [{ label: "Postgres" }, { label: "SQLite", description: "a file" }],
        recommended: 1,
      },
      {
        id: "features",
        question: "Which features?",
        header: "Features",
        multi: true,
        options: [{ label: "Auth" }, { label: "Billing" }],
      },
    ],
  })

  const response = await waitForFrame(
    (frame) => frame.type === "extension_ui_response" && frame.id === "ui_ask_1",
    15000,
  )
  await sleep(2)
  emit({
    type: "tool_execution_end",
    toolCallId: "call_ask",
    isError: false,
    result: {
      content: [{ type: "text", text: "asked=" + JSON.stringify(response.answers ?? response) }],
      details: {},
    },
  })
  await sleep(2)
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })
  await sleep(2)
  emit({ type: "agent_end", yielded: true })
  await sleep(2)
  emit({ type: "prompt_result", promptId: id, agentInvoked: true, status: "completed", sessionSettled: true })
  await sleep(2)
  emit({ type: "session_settled" })
}

// The `ask` tool without a form dialog: it walks its questions one dialog at a
// time. A single choice is one `select`; several answers loop over `select`
// with a "(N selected) " title prefix until the host returns the
// "Done selecting" row; the "Other (type your own)" row makes the tool ask for
// free text itself. The host is expected to answer every request, so this
// scenario records what came back and reports it as the tool result.
async function runSelectPrompt(id) {
  const message = { role: "assistant", content: [] }
  const asked = []
  const dialog = async (frame) => {
    emit(frame)
    const response = await waitForFrame(
      (candidate) => candidate.type === "extension_ui_response" && candidate.id === frame.id,
      15000,
    )
    asked.push({ method: frame.method, title: frame.title, value: response.value ?? response.confirmed })
    return response
  }

  emit({ type: "agent_start" })
  await sleep(2)
  emit({ type: "message_start", message })
  await sleep(2)
  emit({ type: "tool_execution_start", toolCallId: "call_ask", toolName: "ask", args: { html: "<form></form>" } })
  await sleep(2)

  const single = ["Postgres", "SQLite (recommended)", "Other (type your own)"]
  await dialog({ type: "extension_ui_request", id: "ui_select_1", method: "select", title: "Which database?", options: single })

  // A checkbox group: the engine re-asks until the sentinel row comes back.
  const multiple = ["Auth", "Billing", "Other (type your own)", "✔ Done selecting"]
  await dialog({ type: "extension_ui_request", id: "ui_select_2", method: "select", title: "Which features?", options: multiple })
  await dialog({
    type: "extension_ui_request",
    id: "ui_select_3",
    method: "select",
    title: "(1 selected) Which features?",
    options: multiple,
  })
  await dialog({
    type: "extension_ui_request",
    id: "ui_select_4",
    method: "select",
    title: "(2 selected) Which features?",
    options: multiple,
  })

  // Picking the "Other (type your own)" row is the tool's own free-text prompt.
  await dialog({
    type: "extension_ui_request",
    id: "ui_select_5",
    method: "input",
    title: "Your answer",
    placeholder: "type it",
  })

  await sleep(2)
  emit({
    type: "tool_execution_end",
    toolCallId: "call_ask",
    isError: false,
    result: { content: [{ type: "text", text: "asked=" + JSON.stringify(asked) }], details: {} },
  })
  await sleep(2)
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })
  await sleep(2)
  emit({ type: "agent_end", yielded: true })
  await sleep(2)
  emit({ type: "prompt_result", promptId: id, agentInvoked: true, status: "completed", sessionSettled: true })
  await sleep(2)
  emit({ type: "session_settled" })
}

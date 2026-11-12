import assert from "node:assert/strict"
import { test } from "node:test"
import { EventTranslator } from "../src/omp/map.ts"
import type { OmpEvent, SessionEventEnvelope } from "../src/omp/types.ts"

const opts = {
  sessionID: "ses_test",
  directory: "/tmp/openpi",
  projectID: "proj_test",
  agent: "build",
  model: { providerID: "rotator-tokenharbor", id: "deepseek-v4.1-flash:free" },
}

const toolCall = { type: "toolCall", id: "call_1", name: "read", arguments: { filePath: "/tmp/x" } }

function assistant(): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }, toolCall],
    api: "openai-completions",
    provider: "rotator-tokenharbor",
    model: "deepseek-v4.1-flash:free",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 1,
      cacheWrite: 2,
      reasoning: 5,
      totalTokens: 38,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
    stopReason: "toolUse",
    timestamp: 1794505530000,
  }
}

test("maps a full OMP turn to ordered OpenCode envelopes", () => {
  const translator = new EventTranslator(opts)
  const out: SessionEventEnvelope[] = []
  const feed = (event: OmpEvent) => out.push(...translator.translate(event))

  feed({ type: "agent_start" })
  feed({ type: "message_start", message: assistant() })
  const messageID = translator.assistantMessageID()
  assert.ok(messageID?.startsWith("msg_"), "assistant message id is allocated")

  const update = (assistantMessageEvent: Record<string, unknown>) =>
    feed({ type: "message_update", message: assistant(), assistantMessageEvent })

  update({ type: "text_start", contentIndex: 0, partial: assistant() })
  update({ type: "text_delta", contentIndex: 0, delta: "hi", partial: assistant() })
  update({ type: "text_end", contentIndex: 0, content: "hi", partial: assistant() })
  update({ type: "toolcall_start", contentIndex: 1, partial: assistant() })
  update({ type: "toolcall_end", contentIndex: 1, toolCall, partial: assistant() })
  assert.equal(translator.assistantMessageID(), messageID, "message id stays stable within a message")

  feed({ type: "message_end", message: assistant() })
  feed({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { filePath: "/tmp/x" } })
  feed({ type: "tool_execution_update", toolCallId: "call_1", partialResult: { lines: 3 } })
  feed({
    type: "tool_execution_end",
    toolCallId: "call_1",
    result: { content: [{ type: "text", text: "file body" }], details: { lines: 3 } },
    isError: false,
  })
  feed({ type: "agent_end", messages: [], yielded: true })

  assert.deepEqual(out.map((event) => event.type), [
    "session.execution.started",
    "session.step.started",
    "session.text.started",
    "session.text.delta",
    "session.text.ended",
    "session.tool.input.started",
    "session.tool.input.ended",
    "session.step.ended",
    "session.tool.called",
    "session.tool.progress",
    "session.tool.success",
    "session.execution.succeeded",
  ])

  const durable = out.filter((event) => event.durable)
  assert.deepEqual(durable.map((event) => event.durable?.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(translator.seq(), 10, "seq() exposes the next durable sequence")

  for (const event of out) {
    if (!event.durable) continue
    assert.equal(event.durable.aggregateID, opts.sessionID)
    const expected = event.type === "session.tool.success" ? 2 : 1
    assert.equal(event.durable.version, expected, `${event.type} durable version`)
  }

  const ephemeral = out.filter((event) => !event.durable).map((event) => event.type)
  assert.deepEqual(ephemeral, ["session.text.delta", "session.tool.progress"])

  const success = out.find((event) => event.type === "session.tool.success")
  assert.deepEqual(success?.data.content, [{ type: "text", text: "file body" }])

  feed({ type: "message_start", message: assistant() })
  assert.notEqual(translator.assistantMessageID(), messageID, "message id changes on the next message_start")
})

test("interrupted() emits session.execution.interrupted", () => {
  const translator = new EventTranslator(opts)
  const events = translator.interrupted()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, "session.execution.interrupted")
  assert.equal(events[0].data.reason, "user")
  assert.equal(events[0].data.sessionID, opts.sessionID)
  assert.equal(events[0].durable?.version, 1)
  assert.equal(events[0].durable?.seq, 0)
  assert.deepEqual(events[0].location, { directory: opts.directory })
})

test("failed tools are durable v2 and a non-yielded agent_end is dropped", () => {
  const translator = new EventTranslator(opts)
  const out: SessionEventEnvelope[] = []
  out.push(...translator.translate({ type: "message_start", message: assistant() }))
  out.push(
    ...translator.translate({
      type: "tool_execution_end",
      toolCallId: "call_1",
      result: { content: [{ type: "text", text: "boom" }] },
      isError: true,
    }),
  )
  const failed = out.find((event) => event.type === "session.tool.failed")
  assert.equal(failed?.durable?.version, 2)
  assert.deepEqual(failed?.data.content, [{ type: "text", text: "boom" }])
  assert.deepEqual(failed?.data.error, { type: "tool-error", message: "boom" })

  assert.deepEqual(translator.translate({ type: "agent_end", messages: [], yielded: false }), [])
})

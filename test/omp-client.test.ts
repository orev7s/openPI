import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { startOmp } from "../src/omp/client.ts"
import type { OmpClient, OmpEvent, OmpResponse } from "../src/omp/types.ts"

const fakeOmp = fileURLToPath(new URL("./helpers/fake-omp.mjs", import.meta.url))

function waitForEvent(client: OmpClient, predicate: (event: OmpEvent) => boolean, ms = 5000): Promise<OmpEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error("timed out waiting for event"))
    }, ms)
    const off = client.onEvent((event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      off()
      resolve(event)
    })
  })
}

test("starts omp, negotiates protocol v2, and streams a prompt", async () => {
  const client = await startOmp({ command: process.execPath, args: [fakeOmp], cwd: process.cwd() })

  const ready = await client.ready
  assert.equal(ready.type, "ready")
  assert.deepEqual(ready.supportedProtocolVersions, [1, 2])

  const events: OmpEvent[] = []
  client.onEvent((event) => events.push(event))

  const state = (await client.send({ type: "get_state" })) as OmpResponse
  assert.equal(state.success, true)
  assert.equal((state.data as { protocolVersion: number }).protocolVersion, 2)

  const settled = waitForEvent(client, (event) => event.type === "session_settled")
  const prompt = (await client.send({ type: "prompt", text: "hi" })) as OmpResponse
  assert.equal(prompt.success, true)
  assert.deepEqual(prompt.data, { agentInvoked: true })

  await settled

  const deltas = events
    .filter((event) => event.type === "message_update")
    .map((event) => event.assistantMessageEvent as { type: string; delta?: string })
    .filter((update) => update?.type === "text_delta")
    .map((update) => update.delta)
    .filter((delta): delta is string => typeof delta === "string")

  assert.ok(deltas.length >= 2, `expected text deltas, got ${JSON.stringify(events)}`)
  assert.equal(deltas.join(""), "Hello fake omp")
  assert.ok(events.some((event) => event.type === "agent_end"))
  assert.ok(events.some((event) => event.type === "prompt_result" && event.status === "completed"))

  await client.close()
  const exit = await client.exited
  assert.equal(exit.code, 0)
  assert.equal(exit.signal, null)
})

test("abort emits an aborted agent_end", async () => {
  const client = await startOmp({ command: process.execPath, args: [fakeOmp], cwd: process.cwd() })
  await client.ready

  const aborted = waitForEvent(client, (event) => event.type === "agent_end" && event.aborted === true)
  const response = (await client.send({ type: "abort" })) as OmpResponse
  assert.equal(response.success, true)

  const event = await aborted
  assert.equal(event.reason, "aborted")

  await client.close()
  await client.exited
})

test("close is idempotent", async () => {
  const client = await startOmp({ command: process.execPath, args: [fakeOmp], cwd: process.cwd() })
  await client.ready
  await client.close()
  await client.close()
  const exit = await client.exited
  assert.equal(exit.code, 0)
})

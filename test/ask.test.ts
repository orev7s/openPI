// OMP's `ask` dialog, end to end: the engine asks, openPI turns the request
// into a pending form, the UI replies over the form HTTP API, and the answer
// reaches the engine in the shape its request expects.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { createApp } from "../src/server/app.ts"
import type { SessionEventEnvelope } from "../src/omp/types.ts"

const FAKE_OMP = new URL("./helpers/fake-omp.mjs", import.meta.url).pathname
// Title generation spawns a real omp; tests stub it out.
const noTitle = async () => undefined

function appWith(dir: string, scenario = "ask") {
  return createApp({
    directory: dir,
    dataDir: dir,
    storePath: join(dir, "openpi.db"),
    ompCommand: process.execPath,
    ompArgs: [FAKE_OMP, "--scenario", scenario],
    generateTitle: noTitle,
  })
}

interface FormField {
  key: string
  type: string
  description?: string
  custom?: boolean
  options?: { value: string; label: string; description?: string }[]
}

interface FormPayload {
  id: string
  sessionID: string
  title: string
  metadata: { kind?: string }
  fields: FormField[]
}

interface ToolPart {
  type: string
  name?: string
  state?: { content?: { type: string; text?: string }[] }
}

/** The text of the `ask` tool result in a projected transcript. */
function toolResultText(messages: { type: string; content?: ToolPart[] }[]): string | undefined {
  const parts = messages.flatMap((message) => (message.type === "assistant" ? (message.content ?? []) : []))
  const tool = parts.find((part) => part.type === "tool" && part.name === "ask")
  return tool?.state?.content?.find((part) => part.type === "text")?.text
}

async function start(dir: string, scenario = "ask") {
  const app = appWith(dir, scenario)
  await app.listen(0, "127.0.0.1")
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const created = (await api(base, "POST", "/api/session", {})) as { data: { id: string } }
  const id = created.data.id
  const controller = new AbortController()
  const events = collect(await sse(base, controller.signal))
  await api(base, "POST", `/api/session/${id}/prompt`, { text: "ask me something" })
  const seen = await events.until("form.created", 20000)
  const envelope = seen.find((event) => event.type === "form.created")
  assert.ok(envelope, "the engine opened a form")
  const payload = envelope.data.form
  assert.ok(payload && typeof payload === "object", "form.created carries the form")
  // Parsed SSE JSON in a test: asserted to be an object above, read as the form shape.
  return { app, base, id, events, controller, form: payload as FormPayload }
}

test("an ask dialog becomes a question form whose answer reaches the engine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-ask-"))
  const { app, base, id, events, controller, form } = await start(dir)
  try {
    assert.equal(form.sessionID, id)
    assert.equal(form.title, "Questions")
    assert.equal(form.metadata.kind, "question", "the question dock only renders kind=question")
    assert.deepEqual(
      form.fields.map((field) => field.key),
      ["q0", "q1"],
      "one field per question, in the order the model asked",
    )
    assert.equal(form.fields[0].type, "string")
    assert.equal(form.fields[0].description, "Which database?")
    assert.equal(form.fields[1].type, "multiselect")
    assert.equal(form.fields[0].custom, true, "the dock's own free-text answer stays available")

    // The recommended option leads the dock and is labelled, but its *value*,
    // which is what OMP matches against, is still the option's own label.
    assert.deepEqual(
      form.fields[0].options?.map((option) => option.value),
      ["SQLite", "Postgres"],
    )
    assert.equal(form.fields[0].options?.[0].label, "SQLite (Recommended)")
    assert.equal(form.fields[0].options?.[0].description, "a file")

    const listed = (await api(base, "GET", `/api/session/${id}/form`)) as { data: FormPayload[] }
    assert.ok(
      listed.data.some((entry) => entry.id === form.id),
      "pending form is listed for the session",
    )

    await api(base, "POST", `/api/session/${id}/form/${form.id}/reply`, {
      answer: { q0: "SQLite", q1: ["Auth"] },
    })
    await events.until("session.execution.succeeded", 20000)

    assert.ok(
      events.seen.some((event) => event.type === "form.replied"),
      "the reply is broadcast so every client drops the dock",
    )
    const after = (await api(base, "GET", `/api/session/${id}/form`)) as { data: unknown[] }
    assert.equal(after.data.length, 0, "a settled form is no longer pending")

    const messages = (await api(base, "GET", `/api/session/${id}/message`)) as {
      data: { type: string; content?: ToolPart[] }[]
    }
    const text = toolResultText(messages.data)
    assert.ok(text, "the ask tool result is in the transcript")
    assert.deepEqual(JSON.parse(text.slice("asked=".length)), [
      { id: "db", selectedOptions: ["SQLite"] },
      { id: "features", selectedOptions: ["Auth"] },
    ])
  } finally {
    controller.abort()
    await app.close()
  }
})

test("dismissing the dock answers the engine with a cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-ask-"))
  const { app, base, id, events, controller, form } = await start(dir)
  try {
    await api(base, "DELETE", `/api/session/${id}/form/${form.id}`)
    await events.until("session.execution.succeeded", 20000)

    assert.ok(
      events.seen.some((event) => event.type === "form.cancelled"),
      "the dismissal is broadcast",
    )
    const messages = (await api(base, "GET", `/api/session/${id}/message`)) as {
      data: { type: string; content?: ToolPart[] }[]
    }
    const text = toolResultText(messages.data)
    assert.ok(text, "the ask tool result is in the transcript")
    assert.deepEqual(JSON.parse(text.slice("asked=".length)), {
      type: "extension_ui_response",
      id: "ui_ask_1",
      cancelled: true,
    })
  } finally {
    controller.abort()
    await app.close()
  }
})

test("replying twice is refused once the form is settled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-ask-"))
  const { app, base, id, events, controller, form } = await start(dir)
  try {
    await api(base, "POST", `/api/session/${id}/form/${form.id}/reply`, { answer: { q0: "SQLite" } })
    const second = await fetch(`${base}/api/session/${id}/form/${form.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: { q0: "Postgres" } }),
    })
    assert.equal(second.status, 404, "a settled form reads as missing")
    await events.until("session.execution.succeeded", 20000)
  } finally {
    controller.abort()
    await app.close()
  }
})

test("the fallback dialog path answers one question at a time, engine rows included", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-ask-"))
  const { app, base, id, events, controller } = await start(dir, "select")
  try {
    // The engine asks its questions through one dialog at a time; each reply
    // makes it open the next.
    const waitForm = async (count: number): Promise<FormPayload> => {
      await events.until("form.created", 20000, count)
      return nthForm(events.seen, count)
    }
    const reply = (form: FormPayload, answer: Record<string, string>) =>
      api(base, "POST", `/api/session/${id}/form/${form.id}/reply`, { answer })

    // A single choice: options travel to the dock exactly as the engine sent
    // them, its own free-text row included.
    const single = nthForm(events.seen, 1)
    assert.equal(single.title, "Which database?")
    assert.equal(single.fields[0].description, "Which database?", "the dock draws the question from the field")
    assert.deepEqual(
      single.fields[0].options?.map((option) => option.value),
      ["Postgres", "SQLite (recommended)", "Other (type your own)"],
    )
    await reply(single, { q0: "SQLite (recommended)" })

    // A checkbox group: the engine re-asks under a "(N selected) " title and
    // only its own "Done selecting" row ends the loop.
    const group = await waitForm(2)
    assert.equal(group.title, "Which features?")
    await reply(group, { q0: "Auth" })

    const second = await waitForm(3)
    assert.equal(second.title, "(1 selected) Which features?")
    await reply(second, { q0: "Billing" })

    const third = await waitForm(4)
    assert.equal(third.title, "(2 selected) Which features?")
    assert.deepEqual(
      third.fields[0].options?.map((option) => option.value),
      ["Auth", "Billing", "Other (type your own)", "✔ Done selecting"],
    )
    await reply(third, { q0: "✔ Done selecting" })

    // Answering the "Other (type your own)" row makes the engine ask for text.
    const freeText = await waitForm(5)
    assert.equal(freeText.title, "Your answer")
    assert.equal(freeText.fields[0].description, "type it")
    await reply(freeText, { q0: "DuckDB" })

    await events.until("session.execution.succeeded", 20000)
    const messages = (await api(base, "GET", `/api/session/${id}/message`)) as {
      data: { type: string; content?: ToolPart[] }[]
    }
    const text = toolResultText(messages.data)
    assert.ok(text, "the ask tool result is in the transcript")
    assert.deepEqual(JSON.parse(text.slice("asked=".length)), [
      { method: "select", title: "Which database?", value: "SQLite (recommended)" },
      { method: "select", title: "Which features?", value: "Auth" },
      { method: "select", title: "(1 selected) Which features?", value: "Billing" },
      { method: "select", title: "(2 selected) Which features?", value: "✔ Done selecting" },
      { method: "input", title: "Your answer", value: "DuckDB" },
    ])
  } finally {
    controller.abort()
    await app.close()
  }
})

async function api(base: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(base + path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  if (response.status === 204) return undefined
  return response.json()
}

async function sse(base: string, signal: AbortSignal): Promise<Response> {
  return fetch(base + "/api/event", { signal, headers: { accept: "text/event-stream" } })
}

interface Collected {
  seen: SessionEventEnvelope[]
  until(type: string, timeoutMs: number, count?: number): Promise<SessionEventEnvelope[]>
}

/**
 * The form the engine opened, in order. The fallback dialog path opens one form
 * per dialog, so a test replies to them one at a time.
 */
function nthForm(seen: SessionEventEnvelope[], index: number): FormPayload {
  const forms = seen.filter((event) => event.type === "form.created")
  const envelope = forms[index - 1]
  assert.ok(envelope, `expected at least ${index} form(s), saw ${forms.length}`)
  const payload = envelope.data.form
  assert.ok(payload && typeof payload === "object", "form.created carries the form")
  return payload as FormPayload
}

function collect(response: Response): Collected {
  const seen: SessionEventEnvelope[] = []
  const waiters: (() => boolean)[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  // Waiters are woken by arriving frames, never by a polling timer.
  const wake = () => {
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (waiters[index]()) waiters.splice(index, 1)
    }
  }

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index: number
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const line = frame.split("\n").find((entry) => entry.startsWith("data: "))
          if (!line) continue
          try {
            seen.push(JSON.parse(line.slice(6)))
            wake()
          } catch {
            // ignore malformed frames
          }
        }
      }
    } catch {
      // the stream is aborted once the assertion is satisfied
    }
  })()

  return {
    seen,
    until(type, timeoutMs, count = 1) {
      const satisfied = () => seen.filter((event) => event.type === type).length >= count
      if (satisfied()) return Promise.resolve(seen)
      const { promise, resolve, reject } = Promise.withResolvers<SessionEventEnvelope[]>()
      const waiter = () => {
        if (!satisfied()) return false
        clearTimeout(timer)
        resolve(seen)
        return true
      }
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new Error(`timed out waiting for ${count} ${type}; saw ${seen.map((event) => event.type).join(",")}`))
      }, timeoutMs)
      waiters.push(waiter)
      return promise
    },
  }
}

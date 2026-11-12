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

function appWith(dir: string, ompArgs: string[] = [FAKE_OMP]) {
  return createApp({
    directory: dir,
    dataDir: dir,
    storePath: join(dir, "openpi.db"),
    ompCommand: process.execPath,
    ompArgs,
    generateTitle: noTitle,
  })
}

test("a prompt streams assistant text over SSE and persists the transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-"))
  const app = appWith(dir)
  await app.listen(0, "127.0.0.1")
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  try {
    const created = (await api(base, "POST", "/api/session", {})) as { data: { id: string } }
    const id = created.data.id
    assert.ok(id, "session created")

    const controller = new AbortController()
    const events = collect(await sse(base, controller.signal))

    await api(base, "POST", `/api/session/${id}/prompt`, { text: "hello there" })

    const seen = await events.until("session.execution.succeeded", 20000)
    const types = seen.map((event) => event.type)
    assert.ok(types.includes("session.execution.started"), "execution started")
    assert.ok(types.filter((t) => t === "session.text.delta").length > 0, "text streamed")

    const text = seen
      .filter((event) => event.type === "session.text.delta" && event.data.sessionID === id)
      .map((event) => event.data.delta)
      .join("")
    assert.ok(text.length > 0, "accumulated assistant text")
    controller.abort()

    const messages = (await api(base, "GET", `/api/session/${id}/message`)) as { data: Record<string, unknown>[] }
    const assistant = messages.data.find((message) => message.type === "assistant") as
      | { content: { type: string; text?: string }[] }
      | undefined
    assert.ok(assistant, "assistant message persisted")
    const assistantText = assistant.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
    assert.equal(assistantText, text, "persisted text matches the stream")

    const idle = messages.data.find((message) => message.type === "idle")
    assert.ok(idle, "idle marker persisted")

    const listed = (await api(base, "GET", "/api/session")) as { data: { id: string }[] }
    assert.ok(listed.data.some((session) => session.id === id), "session listed")
  } finally {
    await app.close()
  }
})

test("honors client-supplied session and message ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-"))
  const app = appWith(dir)
  await app.listen(0, "127.0.0.1")
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  try {
    const created = (await api(base, "POST", "/api/session", { id: "ses_client" })) as { data: { id: string } }
    assert.equal(created.data.id, "ses_client")

    const got = (await api(base, "GET", "/api/session/ses_client")) as { data: { id: string } }
    assert.equal(got.data.id, "ses_client")

    const prompt = (await api(base, "POST", "/api/session/ses_client/prompt", {
      id: "msg_client",
      text: "hi",
    })) as { data: { id: string } }
    assert.equal(prompt.data.id, "msg_client")

    const messages = (await api(base, "GET", "/api/session/ses_client/message")) as {
      data: { id: string; type: string }[]
    }
    assert.ok(messages.data.some((message) => message.id === "msg_client" && message.type === "user"))
  } finally {
    await app.close()
  }
})

test("an OMP subagent is exposed as an OpenCode child session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-"))
  const app = appWith(dir)
  await app.listen(0, "127.0.0.1")
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  try {
    const created = (await api(base, "POST", "/api/session", { id: "ses_parent" })) as { data: { id: string } }
    const controller = new AbortController()
    const events = collect(await sse(base, controller.signal))

    await api(base, "POST", "/api/session/ses_parent/prompt", { text: "go" })
    await events.until("session.execution.succeeded", 20000)

    const children = (await api(base, "GET", "/api/session?parentID=ses_parent")) as {
      data: { id: string; parentID?: string }[]
    }
    const child = children.data.find((session) => session.id === "FitPanther")
    assert.ok(child, "child session listed under the parent")
    assert.equal(child.parentID, "ses_parent")

    const messages = (await api(base, "GET", "/api/session/FitPanther/message")) as {
      data: { type: string; content?: { text?: string }[] }[]
    }
    const text = messages.data
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.content ?? [])
      .map((part) => part.text)
      .join("")
    assert.equal(text, "sub result")
    controller.abort()
  } finally {
    await app.close()
  }
})

test("a failed turn emits and persists an idle failure instead of hanging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-"))
  const app = appWith(dir, [FAKE_OMP, "--scenario", "error"])
  await app.listen(0, "127.0.0.1")
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  try {
    await api(base, "POST", "/api/session", { id: "ses_error" })
    const controller = new AbortController()
    const events = collect(await sse(base, controller.signal))

    await api(base, "POST", "/api/session/ses_error/prompt", { text: "trigger a provider error" })
    await events.until("session.execution.failed", 20000)

    const messages = (await api(base, "GET", "/api/session/ses_error/message")) as {
      data: { type: string; outcome?: string; error?: { message?: string } }[]
    }
    const idle = messages.data.find((message) => message.type === "idle")
    assert.ok(idle, "a failed turn still records an idle marker")
    assert.equal(idle.outcome, "failed")
    assert.equal(idle.error?.message, "provider exploded")
    controller.abort()
  } finally {
    await app.close()
  }
})

test("a tool without streamed input still renders with its mapped name and output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-"))
  const app = appWith(dir, [FAKE_OMP, "--scenario", "unknown-tool"])
  await app.listen(0, "127.0.0.1")
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  try {
    await api(base, "POST", "/api/session", { id: "ses_tool" })
    const controller = new AbortController()
    const events = collect(await sse(base, controller.signal))

    await api(base, "POST", "/api/session/ses_tool/prompt", { text: "run eval" })
    await events.until("session.execution.succeeded", 20000)

    const messages = (await api(base, "GET", "/api/session/ses_tool/message")) as {
      data: {
        type: string
        content?: { type: string; name?: string; state?: { status: string; content?: { text?: string }[] } }[]
      }[]
    }
    const tool = messages.data
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.content ?? [])
      .find((part) => part.type === "tool")
    assert.ok(tool, "the tool appears in the transcript")
    assert.equal(tool.name, "execute", "eval maps to the OpenCode execute renderer")
    assert.equal(tool.state?.status, "completed")
    assert.equal(tool.state?.content?.[0]?.text, "1")
    controller.abort()
  } finally {
    await app.close()
  }
})

test("the first prompt names the session through the title generator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-"))
  const app = createApp({
    directory: dir,
    dataDir: dir,
    storePath: join(dir, "openpi.db"),
    ompCommand: process.execPath,
    ompArgs: [FAKE_OMP],
    generateTitle: async () => "Fix retry queue job loss",
  })
  await app.listen(0, "127.0.0.1")
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  try {
    await api(base, "POST", "/api/session", { id: "ses_title" })
    const controller = new AbortController()
    const events = collect(await sse(base, controller.signal))

    await api(base, "POST", "/api/session/ses_title/prompt", { text: "the retry queue drops jobs" })
    const seen = await events.until("session.renamed", 20000)
    const renamed = seen.find((event) => event.type === "session.renamed")
    assert.equal(renamed?.data.title, "Fix retry queue job loss")

    const session = (await api(base, "GET", "/api/session/ses_title")) as { data: { title?: string } }
    assert.equal(session.data.title, "Fix retry queue job loss")
    controller.abort()
  } finally {
    await app.close()
  }
})

test("an unnamed first prompt retries the title on a later prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-"))
  let calls = 0
  const app = createApp({
    directory: dir,
    dataDir: dir,
    storePath: join(dir, "openpi.db"),
    ompCommand: process.execPath,
    ompArgs: [FAKE_OMP],
    generateTitle: async () => (++calls === 1 ? undefined : "Second prompt title"),
  })
  await app.listen(0, "127.0.0.1")
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  try {
    await api(base, "POST", "/api/session", { id: "ses_retry" })
    const controller = new AbortController()
    const events = collect(await sse(base, controller.signal))

    await api(base, "POST", "/api/session/ses_retry/prompt", { text: "hi" })
    await events.until("session.execution.succeeded", 20000)
    const first = (await api(base, "GET", "/api/session/ses_retry")) as { data: { title?: string } }
    assert.equal(first.data.title, undefined, "a greeting is not titled")

    await api(base, "POST", "/api/session/ses_retry/prompt", { text: "fix the retry queue" })
    const seen = await events.until("session.renamed", 20000)
    assert.equal(seen.find((event) => event.type === "session.renamed")?.data.title, "Second prompt title")
    controller.abort()
  } finally {
    await app.close()
  }
})

async function api(base: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(base + path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  if (response.status === 204) return undefined
  return response.json()
}

async function sse(base: string, signal: AbortSignal): Promise<Response> {
  return fetch(base + "/api/event", { signal, headers: { accept: "text/event-stream" } })
}

interface Collected {
  until(type: string, timeoutMs: number): Promise<SessionEventEnvelope[]>
}

function collect(response: Response): Collected {
  const seen: SessionEventEnvelope[] = []
  const waiters: (() => void)[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

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
            for (const wake of waiters.splice(0)) wake()
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
    until(type, timeoutMs) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs
        const check = () => {
          if (seen.some((event) => event.type === type)) return resolve(seen)
          if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${type}; saw ${seen.map((e) => e.type).join(",")}`))
          waiters.push(check)
          setTimeout(check, 200)
        }
        check()
      })
    },
  }
}

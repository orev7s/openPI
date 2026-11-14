// The pending-form registry: what the engine bridge opens, what the UI routes
// settle, and the events each transition publishes.

import { test } from "node:test"
import assert from "node:assert/strict"
import { Feed } from "../src/core/feed.ts"
import { Forms, type FormField } from "../src/core/forms.ts"
import type { SessionEventEnvelope } from "../src/omp/types.ts"

const LOCATION = { directory: "/tmp/openpi-forms" }
const FIELD: FormField = { key: "q0", type: "string", options: [{ value: "a", label: "a" }], custom: true }

function recorder() {
  const feed = new Feed()
  const events: SessionEventEnvelope[] = []
  const subscriber = feed.subscribe()
  let pending = Promise.resolve()
  void (async () => {
    for await (const envelope of subscriber.stream()) events.push(envelope)
  })()
  return {
    feed,
    events,
    /** Let the subscriber drain what was published so far. */
    settle: async () => {
      pending = pending.then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      await pending
    },
  }
}

test("an answered form resolves the asker and publishes both transitions", async () => {
  const { feed, events, settle } = recorder()
  const forms = new Forms(feed)
  const { id, outcome } = forms.ask({
    sessionID: "ses_1",
    location: LOCATION,
    title: "Questions",
    metadata: { kind: "question" },
    fields: [FIELD],
  })

  assert.ok(id.startsWith("frm_"))
  assert.equal(forms.has(id), true)
  assert.deepEqual(forms.list("ses_1"), [
    { id, sessionID: "ses_1", title: "Questions", metadata: { kind: "question" }, fields: [FIELD] },
  ])
  assert.deepEqual(forms.detail("ses_1", id)?.state, { status: "pending" })
  assert.deepEqual(forms.list("ses_other"), [])

  assert.equal(forms.reply("ses_1", id, { q0: "a" }), true)
  assert.deepEqual(await outcome, { status: "answered", answer: { q0: "a" } })
  assert.equal(forms.has(id), false)
  assert.equal(forms.reply("ses_1", id, { q0: "a" }), false, "a settled form cannot be answered again")

  await settle()
  assert.deepEqual(
    events.map((event) => event.type),
    ["form.created", "form.replied"],
  )
  assert.deepEqual(events[0].location, LOCATION)
  const created = events[0].data.form
  assert.ok(created && typeof created === "object" && "id" in created, "form.created carries the form")
  assert.equal(created.id, id)
  assert.deepEqual(events[1].data, { id, sessionID: "ses_1", answer: { q0: "a" } })
  assert.equal(events[0].durable, undefined, "forms are ephemeral: never in the transcript")
})

test("a dismissed form cancels, and one session's forms never touch another's", async () => {
  const { feed, events, settle } = recorder()
  const forms = new Forms(feed)
  const first = forms.ask({ sessionID: "ses_1", location: LOCATION, title: "A", metadata: {}, fields: [FIELD] })
  const second = forms.ask({ sessionID: "ses_2", location: LOCATION, title: "B", metadata: {}, fields: [FIELD] })

  assert.equal(forms.cancel("ses_1", first.id, "user dismissed"), true)
  assert.deepEqual(await first.outcome, { status: "cancelled", message: "user dismissed" })
  assert.equal(forms.has(second.id), true, "the other session's form is untouched")

  forms.cancelSession("ses_2", "session stopped")
  assert.deepEqual(await second.outcome, { status: "cancelled", message: "session stopped" })

  await settle()
  assert.deepEqual(
    events.map((event) => event.type),
    ["form.created", "form.created", "form.cancelled", "form.cancelled"],
  )
  assert.equal(forms.list().length, 0)
})

test("a form nobody answers times out with the flag OMP resolves defaults from", async () => {
  const { feed } = recorder()
  const forms = new Forms(feed)
  const { outcome } = forms.ask({
    sessionID: "ses_1",
    location: LOCATION,
    title: "Questions",
    metadata: {},
    fields: [FIELD],
    timeoutMs: 5,
  })

  assert.deepEqual(await outcome, { status: "cancelled", message: "timed out", timedOut: true })
})

test("a location only lists its own pending forms", () => {
  const { feed } = recorder()
  const forms = new Forms(feed)
  forms.ask({ sessionID: "ses_1", location: LOCATION, title: "A", metadata: {}, fields: [FIELD] })
  forms.ask({ sessionID: "ses_2", location: { directory: "/tmp/other" }, title: "B", metadata: {}, fields: [FIELD] })

  assert.equal(forms.list(undefined, LOCATION.directory).length, 1)
  assert.equal(forms.list().length, 2)
  assert.equal(forms.detail("ses_2", forms.list()[0].id), undefined, "a session only sees its own form")
})

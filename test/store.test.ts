import { test } from "node:test"
import assert from "node:assert/strict"
import { Store } from "../src/core/store.ts"

test("persists, loads, lists and deletes sessions", () => {
  const store = new Store(":memory:")
  const info = { id: "ses_1", location: { directory: "/tmp" } }
  const messages = [{ id: "msg_1", type: "user" }]

  store.save("ses_1", { info, messages })
  assert.deepEqual(store.load("ses_1"), { info, messages })
  assert.equal(store.load("missing"), undefined)

  store.save("ses_1", { info: { ...info, title: "renamed" }, messages })
  assert.equal((store.load("ses_1")!.info as { title?: string }).title, "renamed")

  store.save("ses_2", { info: { id: "ses_2" }, messages: [] })
  assert.equal(store.list().length, 2)

  store.delete("ses_1")
  assert.equal(store.load("ses_1"), undefined)
  assert.equal(store.list().length, 1)
  store.close()
})

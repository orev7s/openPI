import { test } from "node:test"
import assert from "node:assert/strict"
import { Feed } from "../src/core/feed.ts"
import type { SessionEventEnvelope } from "../src/omp/types.ts"

const env = (type: string): SessionEventEnvelope => ({
  id: "evt_" + type,
  created: 0,
  type,
  data: { sessionID: "ses_1" },
})

test("delivers published envelopes in order to each subscriber", async () => {
  const feed = new Feed()
  const a = feed.subscribe()
  const b = feed.subscribe()
  const ai = a.stream()
  const bi = b.stream()

  feed.publish(env("one"))
  feed.publish(env("two"))

  assert.equal((await ai.next()).value?.type, "one")
  assert.equal((await ai.next()).value?.type, "two")
  assert.equal((await bi.next()).value?.type, "one")
  feed.unsubscribe(a)
  feed.unsubscribe(b)
})

test("closing a subscriber ends its stream", async () => {
  const feed = new Feed()
  const subscriber = feed.subscribe()
  const iterator = subscriber.stream()
  feed.unsubscribe(subscriber)
  assert.equal((await iterator.next()).done, true)
})

test("an overflowing subscriber is terminated without affecting the feed", async () => {
  const feed = new Feed()
  const slow = feed.subscribe()
  const slowIterator = slow.stream()

  for (let i = 0; i < 5000; i++) feed.publish(env("e" + i))

  assert.equal(slow.closed, true)
  assert.equal((await slowIterator.next()).done, true)

  // A subscriber that attaches after the overflow still receives new frames.
  const healthy = feed.subscribe()
  const healthyIterator = healthy.stream()
  feed.publish(env("last"))
  assert.equal((await healthyIterator.next()).value?.type, "last")
})

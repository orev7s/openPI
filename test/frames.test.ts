import { test } from "node:test"
import assert from "node:assert/strict"
import { encodeFrame, RpcFrameDecoder } from "../src/omp/frames.ts"

test("encodeFrame appends a newline", () => {
  assert.equal(encodeFrame({ type: "ready" }), '{"type":"ready"}\n')
})

test("decodes newline-delimited frames", () => {
  const decoder = new RpcFrameDecoder()
  const frames = decoder.push('{"type":"ready","protocolVersion":1}\n{"type":"notice","level":"info"}\n')
  assert.deepEqual(frames, [
    { type: "ready", protocolVersion: 1 },
    { type: "notice", level: "info" },
  ])
})

test("reassembles a line split across pushes", () => {
  const decoder = new RpcFrameDecoder()
  assert.deepEqual(decoder.push('{"type":"pro'), [])
  assert.deepEqual(decoder.push('mpt","id":"c1"'), [])
  assert.deepEqual(decoder.push("}\n"), [{ type: "prompt", id: "c1" }])
})

test("ignores blank lines and CRLF", () => {
  const decoder = new RpcFrameDecoder()
  assert.deepEqual(decoder.push('\r\n  \n{"a":1}\n\n'), [{ a: 1 }])
})

test("keeps multi-byte characters split across pushes intact", () => {
  const decoder = new RpcFrameDecoder()
  const encoded = Buffer.from('{"text":"héllo ☃"}\n', "utf8")
  assert.deepEqual(decoder.push(encoded.subarray(0, 12)), [])
  assert.deepEqual(decoder.push(encoded.subarray(12)), [{ text: "héllo ☃" }])
})

test("throws on malformed JSON", () => {
  const decoder = new RpcFrameDecoder()
  assert.throws(() => decoder.push("{oops}\n"), /malformed JSON/)
})

test("reassembles a v2 chunked frame", () => {
  const decoder = new RpcFrameDecoder()
  const payload = JSON.stringify({ type: "message_end", message: { text: "x".repeat(100) } })
  const bytes = Buffer.from(payload, "utf8")
  const segments = [bytes.subarray(0, 40), bytes.subarray(40, 90), bytes.subarray(90)]
  const results: unknown[] = []
  segments.forEach((segment, index) => {
    const frame = {
      type: "rpc_chunk",
      chunkId: 7,
      index,
      count: segments.length,
      byteLength: bytes.length,
      data: segment.toString("base64"),
    }
    results.push(...decoder.push(JSON.stringify(frame) + "\n"))
  })
  assert.equal(results.length, 1)
  assert.deepEqual(results[0], JSON.parse(payload))
})

test("rejects a new chunkId while a sequence is open", () => {
  const decoder = new RpcFrameDecoder()
  const chunk = (chunkId, index) =>
    JSON.stringify({ type: "rpc_chunk", chunkId, index, count: 2, byteLength: 4, data: "eA==" }) + "\n"
  decoder.push(chunk("a", 0))
  assert.throws(() => decoder.push(chunk("b", 0)), /chunkId changed/)
})

test("rejects an out-of-order or duplicate chunk index", () => {
  const decoder = new RpcFrameDecoder()
  const chunk = (index) =>
    JSON.stringify({ type: "rpc_chunk", chunkId: "a", index, count: 3, byteLength: 4, data: "eA==" }) + "\n"
  decoder.push(chunk(0))
  assert.throws(() => decoder.push(chunk(2)), /expected index 1, got 2/)
})

test("rejects a count mismatch mid-sequence", () => {
  const decoder = new RpcFrameDecoder()
  const frame = (index, count) =>
    JSON.stringify({ type: "rpc_chunk", chunkId: "a", index, count, byteLength: 4, data: "eA==" }) + "\n"
  decoder.push(frame(0, 3))
  assert.throws(() => decoder.push(frame(1, 2)), /count changed/)
})

test("rejects reassembly past the configured limit", () => {
  const decoder = new RpcFrameDecoder({ maxReassembledFrameBytes: 4 })
  const frame = JSON.stringify({ type: "rpc_chunk", chunkId: "a", index: 0, count: 1, byteLength: 8, data: "eA==" }) + "\n"
  assert.throws(() => decoder.push(frame), /exceeds maxReassembledFrameBytes/)
})

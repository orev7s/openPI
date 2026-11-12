import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { materializeAttachments, repairStoredMessages } from "../src/core/attachments.ts"

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

test("an inline image becomes a decodable file and an OMP image", async () => {
  const result = await materializeAttachments(
    [{ uri: `data:image/png;base64,${PNG_B64}`, name: "red.png" }],
    "/tmp",
  )

  assert.deepEqual(result.files, [
    { data: PNG_B64, mime: "image/png", source: { type: "inline" }, name: "red.png" },
  ])
  assert.deepEqual(result.images, [{ type: "image", data: PNG_B64, mimeType: "image/png" }])
  assert.equal(result.context, "")
})

test("a filesystem path reads bytes and marks the uri source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-attach-"))
  await writeFile(join(dir, "notes.md"), "# hello\nbody\n")

  const result = await materializeAttachments([{ uri: "notes.md", name: "notes.md" }], dir)

  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].mime, "text/markdown")
  assert.deepEqual(result.files[0].source, { type: "uri", uri: pathToFileURL(join(dir, "notes.md")).href })
  assert.equal(Buffer.from(result.files[0].data, "base64").toString("utf8"), "# hello\nbody\n")
  assert.equal(result.images.length, 0)
  assert.match(result.context, /# hello/)
})

test("a file: uri is read and an unsupported scheme is skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-attach-"))
  await writeFile(join(dir, "a.txt"), "alpha")

  const fileUri = pathToFileURL(join(dir, "a.txt")).href
  const read = await materializeAttachments([{ uri: fileUri }], dir)
  assert.equal(read.files[0].mime, "text/plain")
  assert.match(read.context, /alpha/)

  const skipped = await materializeAttachments([{ uri: "https://example.com/x.png" }], dir)
  assert.deepEqual(skipped.files, [])
  assert.deepEqual(skipped.images, [])
})

test("repairStoredMessages upgrades legacy { uri } files in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-attach-"))
  const messages = [
    { type: "user", text: "look", files: [{ uri: `data:image/png;base64,${PNG_B64}`, name: "red.png" }] },
    { type: "assistant", content: [] },
  ]

  assert.equal(repairStoredMessages(messages, dir), true)
  assert.deepEqual(messages[0].files, [
    { data: PNG_B64, mime: "image/png", source: { type: "inline" }, name: "red.png" },
  ])
  // Idempotent: a second pass changes nothing.
  assert.equal(repairStoredMessages(messages, dir), false)
})

test("repairStoredMessages drops attachments it cannot read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-attach-"))
  const messages = [{ type: "user", text: "dir", files: [{ uri: `${dir}/`, name: "dir" }] }]

  assert.equal(repairStoredMessages(messages, dir), true)
  assert.deepEqual(messages[0].files, [])
})

test("a malformed attachment is dropped instead of failing the prompt", async () => {
  const result = await materializeAttachments(
    [{ uri: "data:image/png;base64" }, { notAUri: true }, null, { uri: "data:image/png;base64,not-base64!" }],
    "/tmp",
  )
  assert.deepEqual(result.files, [])
  assert.deepEqual(result.images, [])
})

test("a binary non-image keeps a descriptive note without an image", async () => {
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString("base64")
  const result = await materializeAttachments([{ uri: `data:application/pdf;base64,${bytes}`, name: "doc.pdf" }], "/tmp")

  assert.equal(result.images.length, 0)
  assert.equal(result.files[0].mime, "application/pdf")
  assert.match(result.context, /doc\.pdf/)
})

test("an invalid mention is dropped, a valid one is kept", async () => {
  const invalid = await materializeAttachments(
    [{ uri: `data:text/plain;base64,${Buffer.from("x").toString("base64")}`, mention: { start: "0", end: 1, text: "x" } }],
    "/tmp",
  )
  assert.equal(invalid.files[0].mention, undefined)

  const valid = await materializeAttachments(
    [{ uri: `data:text/plain;base64,${Buffer.from("x").toString("base64")}`, mention: { start: 0, end: 1, text: "x" } }],
    "/tmp",
  )
  assert.deepEqual(valid.files[0].mention, { start: 0, end: 1, text: "x" })
})

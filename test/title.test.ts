import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateTitle, parseTitle } from "../src/core/title.ts"

test("parseTitle reads the tagged title and rejects the no-title sentinels", () => {
  assert.equal(parseTitle("<title>Fix retry queue</title>"), "Fix retry queue")
  assert.equal(parseTitle("Working...\n<title>Add dark mode</title>\n"), "Add dark mode")
  assert.equal(parseTitle("<title>  Fix   the   thing </title>"), "Fix the thing")
  assert.equal(parseTitle("<title>none</title>"), undefined)
  assert.equal(parseTitle("<title/>"), undefined)
  assert.equal(parseTitle("   "), undefined)
})

test("generateTitle spawns the command and parses its stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-title-"))
  const script = join(dir, "title.mjs")
  await writeFile(script, 'process.stdout.write("<title>Fix the thing</title>")\n')
  const title = await generateTitle({ command: process.execPath, args: [script], cwd: dir, text: "fix the thing" })
  assert.equal(title, "Fix the thing")
})

test("generateTitle resolves undefined when the call hangs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openpi-title-"))
  const script = join(dir, "slow.mjs")
  await writeFile(script, "setTimeout(() => {}, 60000)\n")
  const title = await generateTitle({ command: process.execPath, args: [script], cwd: dir, text: "x", timeoutMs: 200 })
  assert.equal(title, undefined)
})

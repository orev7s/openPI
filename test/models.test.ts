import { test } from "node:test"
import assert from "node:assert/strict"
import { toModelInfo } from "../src/core/manager.ts"

test("model variants mirror OMP thinking efforts", () => {
  const info = toModelInfo({
    id: "deepseek-v4.1-flash:free",
    provider: "rotator-tokenharbor",
    name: "DeepSeek V4.1 Flash (Free)",
    input: ["text"],
    reasoning: true,
    thinking: { mode: "effort", efforts: ["low", "high", "max"] },
    contextWindow: 1000000,
    maxTokens: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })

  assert.deepEqual(info.variants, [
    { id: "low", settings: {} },
    { id: "high", settings: {} },
    { id: "max", settings: {} },
  ])
  assert.equal((info.capabilities as { reasoning?: boolean }).reasoning, true)

  const plain = toModelInfo({ id: "x", provider: "p", input: ["text"] })
  assert.deepEqual(plain.variants, [])
})

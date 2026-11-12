import { spawn } from "node:child_process"

// Mirrors OMP's own title prompt. OMP forces PI_NO_TITLE=1 in RPC mode, so the
// session is named here with one short out-of-band print-mode call.
const TITLE_SYSTEM_PROMPT =
  "You name coding-agent sessions. Write a 3-6 word title for the task in the next message. " +
  "Output exactly one line: the title inside <title> tags, or <title/> when there is no task to name. " +
  "No quotes, trailing punctuation, or explanations."

const TITLE_FLAGS = [
  "-p",
  "--no-session",
  "--no-tools",
  "--no-lsp",
  "--no-pty",
  "--no-context-files",
  "--no-rules",
  "--no-skills",
  "--no-extensions",
  "--no-title",
]

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_INPUT_CHARS = 2_000
const MAX_TITLE_CHARS = 100

export interface TitleOptions {
  command: string
  args?: string[]
  cwd: string
  text: string
  timeoutMs?: number
}

export type TitleGenerator = (options: TitleOptions) => Promise<string | undefined>

/** Extracts the title from an OMP print-mode response. */
export function parseTitle(output: string): string | undefined {
  if (/<title\s*\/>/i.test(output)) return undefined
  const tagged = output.match(/<title>([\s\S]*?)<\/title>/i)
  const raw = tagged ? tagged[1] : output.split("\n").map((line) => line.trim()).find(Boolean) ?? ""
  const title = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS)
  if (!title || /^none$/i.test(title)) return undefined
  return title
}

export const generateTitle: TitleGenerator = (options) =>
  new Promise((resolve) => {
    const child = spawn(
      options.command,
      [
        ...(options.args ?? []),
        ...TITLE_FLAGS,
        "--system-prompt",
        TITLE_SYSTEM_PROMPT,
        // A leading dash would be parsed as a flag; prefix to keep it positional.
        `User request:\n${options.text.slice(0, MAX_INPUT_CHARS)}`,
      ],
      { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "ignore"] },
    )
    let output = ""
    let settled = false
    const finish = (title: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(title)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(undefined)
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 100_000) output += chunk.toString("utf8")
    })
    child.on("error", () => finish(undefined))
    child.on("close", () => finish(parseTitle(output)))
  })

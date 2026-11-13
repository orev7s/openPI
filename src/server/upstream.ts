import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface Upstream {
  url: string
  password: string
  directory: string
  stop(): Promise<void>
}

// The vendored OpenCode fork ships in `opencode/`. When it is checked out and
// its web app is built, run it from source so the openPI UI changes are what
// gets served. Otherwise fall back to the `opencode` binary on PATH.
function defaultCommand(): { command: string; args: string[]; local?: boolean } {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
  const entry = join(root, "opencode", "packages", "cli", "src", "index.ts")
  const built = join(root, "opencode", "packages", "app", "dist", "index.html")
  if (existsSync(entry) && existsSync(built)) {
    const bun = process.env.OPENPI_BUN ?? (existsSync(join(homedir(), ".bun", "bin", "bun")) ? join(homedir(), ".bun", "bin", "bun") : "bun")
    return {
      command: bun,
      args: ["run", "--cwd", join(root, "opencode", "packages", "cli"), "src/index.ts"],
      local: true,
    }
  }
  return { command: "opencode", args: [] }
}

// A private `opencode serve` used only as a source of the built web UI and the
// non-engine endpoints openPI does not own. openPI never routes the agent
// engine here.
export async function startUpstream(options: {
  command?: string
  args?: string[]
  directory: string
  timeoutMs?: number
}): Promise<Upstream | undefined> {
  const resolved = options.command
    ? { command: options.command, args: options.args ?? [], local: false }
    : options.args
      ? { command: "opencode", args: options.args, local: false }
      : defaultCommand()
  const password = randomBytes(24).toString("base64url")
  if (process.env.OPENPI_DEBUG) console.error("[openpi] upstream:", resolved.command, resolved.args.join(" "))
  const child = spawn(resolved.command, [...resolved.args, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: options.directory,
    env: {
      ...process.env,
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      // A local source build reads the web assets from packages/app/dist
      // instead of the embedded bundle.
      ...(resolved.local ? { OPENCODE_CHANNEL: "local" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const url = await new Promise<string | undefined>((resolve) => {
    let buffer = ""
    const timeout = setTimeout(() => resolve(undefined), options.timeoutMs ?? 60000)
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const match = buffer.match(/server listening on (http:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve(undefined)
    })
  })

  if (!url) {
    child.kill("SIGKILL")
    return undefined
  }

  return {
    url,
    password,
    directory: options.directory,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once("exit", () => resolve())
        child.kill("SIGTERM")
        setTimeout(() => child.kill("SIGKILL"), 3000)
      }),
  }
}

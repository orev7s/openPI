import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"

export interface Upstream {
  url: string
  password: string
  directory: string
  stop(): Promise<void>
}

// A private `opencode serve` used only as a source of the built web UI and the
// non-engine endpoints openPI does not own. openPI never routes the agent
// engine here.
export async function startUpstream(options: {
  command?: string
  directory: string
  timeoutMs?: number
}): Promise<Upstream | undefined> {
  const command = options.command ?? "opencode"
  const password = randomBytes(24).toString("base64url")
  const child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: options.directory,
    env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const url = await new Promise<string | undefined>((resolve) => {
    let buffer = ""
    const timeout = setTimeout(() => resolve(undefined), options.timeoutMs ?? 20000)
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

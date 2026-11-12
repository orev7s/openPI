import { homedir } from "node:os"
import { join } from "node:path"
import { createApp } from "./server/app.ts"
import { startUpstream, type Upstream } from "./server/upstream.ts"

const env = process.env
const directory = env.OPENPI_DIRECTORY ?? process.cwd()
const dataDir = env.OPENPI_DATA_DIR ?? join(homedir(), ".openpi")
const port = Number(env.OPENPI_PORT ?? 4096)
const host = env.OPENPI_HOST ?? "0.0.0.0"
const password = env.OPENPI_PASSWORD ?? env.OPENCODE_PASSWORD ?? env.OPENCODE_SERVER_PASSWORD
const ompArgs = env.OPENPI_OMP_ARGS ? env.OPENPI_OMP_ARGS.split(" ").filter(Boolean) : undefined

let upstream: Upstream | undefined
if (env.OPENPI_UPSTREAM) {
  upstream = {
    url: env.OPENPI_UPSTREAM,
    directory,
    stop: async () => {},
  }
} else if (env.OPENPI_UPSTREAM_DISABLE !== "1") {
  upstream = await startUpstream({ command: env.OPENPI_OPENCODE_COMMAND, directory })
  if (!upstream) console.warn("openPI: could not start a private opencode upstream; the web UI will be unavailable")
}

const app = createApp({
  directory,
  dataDir,
  password,
  ...(upstream ? { upstream } : {}),
  ...(env.OPENPI_UPSTREAM_PASSWORD ? { upstreamPassword: env.OPENPI_UPSTREAM_PASSWORD } : {}),
  ...(env.OPENPI_OMP_COMMAND ? { ompCommand: env.OPENPI_OMP_COMMAND } : {}),
  ...(ompArgs ? { ompArgs } : {}),
})

await app.listen(port, host)
console.log(`openPI listening on http://${host}:${port}`)
console.log(`  project:  ${directory}`)
console.log(`  data:     ${dataDir}`)
console.log(`  upstream: ${upstream?.url ?? "none"}`)
if (!password) console.log("  auth:     disabled (set OPENPI_PASSWORD to require Basic auth)")

const shutdown = async () => {
  await app.close()
  await upstream?.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

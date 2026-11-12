import { createServer, type Server } from "node:http"
import { Manager } from "../core/manager.ts"
import { Feed } from "../core/feed.ts"
import { Store } from "../core/store.ts"
import { handleOwned, type RouteContext } from "./routes.ts"
import { proxy } from "./proxy.ts"
import { sendError } from "./http.ts"
import type { Upstream } from "./upstream.ts"

export interface AppOptions {
  directory: string
  dataDir: string
  version?: string
  password?: string
  upstream?: Upstream
  upstreamPassword?: string
  ompCommand?: string
  ompArgs?: string[]
  storePath?: string
}

export interface App {
  server: Server
  manager: Manager
  feed: Feed
  listen(port: number, host: string): Promise<void>
  close(): Promise<void>
}

export function createApp(options: AppOptions): App {
  const feed = new Feed()
  const store = new Store(options.storePath ?? options.dataDir + "/openpi.db")
  const manager = new Manager({
    feed,
    store,
    directory: options.directory,
    dataDir: options.dataDir,
    ...(options.ompCommand ? { command: options.ompCommand } : {}),
    ...(options.ompArgs ? { args: options.ompArgs } : {}),
  })
  const version = options.version ?? "openpi/0.0.1"

  const server = createServer((req, res) => {
    if (process.env.OPENPI_DEBUG) {
      const started = Date.now()
      res.on("finish", () => console.log(`[http] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`))
    }
    void dispatch({
      req,
      res,
      url: new URL(req.url ?? "/", "http://localhost"),
      manager,
      feed,
      directory: options.directory,
      version,
      password: options.password,
      upstream: options.upstream,
      upstreamPassword: options.upstreamPassword,
    }).catch((error) => {
      if (!res.headersSent) sendError(res, 500, "UnknownError", String(error))
      else res.end()
    })
  })

  return {
    server,
    manager,
    feed,
    listen: (port, host) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => resolve())
      }),
    close: async () => {
      await manager.close()
      store.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

interface DispatchOptions extends RouteContext {
  password?: string
  upstream?: Upstream
  upstreamPassword?: string
}

async function dispatch(options: DispatchOptions): Promise<void> {
  const { req, res, url } = options
  const path = url.pathname
  const isApi = path === "/api" || path.startsWith("/api/") || path.startsWith("/auth/") || path === "/openapi.json"

  if (!isApi) {
    if (options.upstream) return proxy(req, res, options.upstream.url, upstreamPassword(options))
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("openPI: no upstream configured, static UI unavailable\n")
    return
  }

  if (options.password && !authorized(req, url, options.password)) {
    sendError(res, 401, "UnauthorizedError", "Authentication required")
    return
  }

  if (await handleOwned(options)) return

  if (options.upstream) return proxy(req, res, options.upstream.url, upstreamPassword(options))
  sendError(res, 404, "InvalidRequestError", `No route for ${path}`)
}

function upstreamPassword(options: DispatchOptions): string | undefined {
  return options.upstreamPassword ?? options.upstream?.password
}

// Mirrors the upstream: Basic auth header, or an `auth_token` query parameter
// holding the base64 of "username:password" (EventSource cannot set headers).
function authorized(req: import("node:http").IncomingMessage, url: URL, password: string): boolean {
  const token = url.searchParams.get("auth_token")
  if (token) return matches(decodeCredential(token), password)
  const header = req.headers.authorization
  if (header?.startsWith("Basic ")) return matches(decodeCredential(header.slice(6)), password)
  return false
}

function decodeCredential(input: string): string {
  const decoded = Buffer.from(input, "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  return separator === -1 ? "" : decoded.slice(separator + 1)
}

function matches(provided: string, password: string): boolean {
  return provided === password
}

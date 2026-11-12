import { hostname } from "node:os"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Manager, projectID } from "../core/manager.ts"
import { eventID } from "../core/ids.ts"
import type { Feed } from "../core/feed.ts"
import { readJson, sendError, sendJson, withLocation } from "./http.ts"

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  manager: Manager
  feed: Feed
  directory: string
  version: string
}

const now = () => Date.now()

// Handles every route openPI owns. Returns false when the request belongs to
// the upstream (static UI or a peripheral API).
export async function handleOwned(ctx: RouteContext): Promise<boolean> {
  const { req, res, url } = ctx
  const path = url.pathname
  const method = req.method ?? "GET"

  if (path === "/api/info" && method === "GET") {
    sendJson(res, 200, {
      version: ctx.version,
      pid: process.pid,
      hostname: hostname(),
      urls: [`http://${hostname()}`],
      paths: {},
      capabilities: { persistentPty: false },
    })
    return true
  }

  if (path === "/api/location" && method === "GET") {
    sendJson(res, 200, {
      directory: ctx.directory,
      project: { id: projectID(ctx.directory), directory: ctx.directory, canonical: ctx.directory },
    })
    return true
  }

  if (path === "/api/event" && method === "GET") {
    await streamEvents(ctx)
    return true
  }

  if (path === "/api/model" && method === "GET") {
    sendJson(res, 200, withLocation(ctx.directory, await ctx.manager.models()))
    return true
  }

  if (path === "/api/model/default" && method === "GET") {
    const models = await ctx.manager.models()
    sendJson(res, 200, withLocation(ctx.directory, models[0] ?? null))
    return true
  }

  if (path === "/api/provider" && method === "GET") {
    sendJson(res, 200, withLocation(ctx.directory, await providers(ctx)))
    return true
  }

  if (path === "/api/agent" && method === "GET") {
    sendJson(res, 200, withLocation(ctx.directory, AGENTS))
    return true
  }

  if (path === "/api/session" && method === "GET") {
    sendJson(res, 200, { data: ctx.manager.listSessions(), cursor: {} })
    return true
  }

  if (path === "/api/session" && method === "POST") {
    const body = await readJson(req)
    sendJson(res, 200, { data: ctx.manager.createSession(body as never) })
    return true
  }

  const rest = sessionRoute(path)
  if (rest) return await handleSession(ctx, method, rest)

  return false
}

type SessionRoute = { id: string; action?: string }

function sessionRoute(path: string): SessionRoute | undefined {
  const match = path.match(/^\/api\/session\/([^/]+)(?:\/([^/]+))?$/)
  if (!match) return undefined
  return { id: match[1], action: match[2] }
}

async function handleSession(ctx: RouteContext, method: string, route: SessionRoute): Promise<boolean> {
  const { req, res, manager } = ctx
  const info = manager.getSession(route.id)
  if (!info) {
    sendError(res, 404, "SessionNotFoundError", `Session not found: ${route.id}`)
    return true
  }

  if (!route.action && method === "GET") {
    sendJson(res, 200, { data: info })
    return true
  }
  if (!route.action && method === "PATCH") {
    const body = await readJson(req)
    const updated = typeof body.title === "string" ? manager.renameSession(route.id, body.title) : info
    sendJson(res, 200, { data: updated })
    return true
  }
  if (!route.action && method === "DELETE") {
    await manager.deleteSession(route.id)
    res.writeHead(204).end()
    return true
  }

  switch (route.action) {
    case "prompt": {
      const body = await readJson(req)
      const data = await manager.prompt(route.id, body as never)
      if (!data) {
        sendError(res, 404, "SessionNotFoundError", `Session not found: ${route.id}`)
        return true
      }
      sendJson(res, 200, { data })
      return true
    }
    case "message": {
      sendJson(res, 200, { data: manager.messages(route.id) ?? [], cursor: {} })
      return true
    }
    case "interrupt": {
      await manager.interrupt(route.id)
      res.writeHead(204).end()
      return true
    }
    case "model": {
      const body = await readJson(req)
      const providerID = body.providerID ?? body.provider
      const modelID = body.modelID ?? body.model
      if (typeof providerID === "string" && typeof modelID === "string") {
        await manager.setModel(route.id, { providerID, modelID })
      }
      res.writeHead(204).end()
      return true
    }
    case "agent":
      res.writeHead(204).end()
      return true
    default:
      return false
  }
}

async function streamEvents(ctx: RouteContext): Promise<void> {
  const { req, res, feed } = ctx
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.write(`data: ${JSON.stringify({ id: eventID(), type: "server.connected", data: {} })}\n\n`)

  const subscriber = feed.subscribe()
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000)
  req.on("close", () => {
    clearInterval(heartbeat)
    feed.unsubscribe(subscriber)
  })

  for await (const envelope of subscriber.stream()) {
    res.write(`data: ${JSON.stringify(envelope)}\n\n`)
  }
  clearInterval(heartbeat)
  res.end()
}

async function providers(ctx: RouteContext): Promise<Record<string, unknown>[]> {
  const models = await ctx.manager.models()
  const seen = new Map<string, Record<string, unknown>>()
  for (const model of models) {
    const id = String(model.providerID)
    if (seen.has(id)) continue
    seen.set(id, {
      id,
      integrationID: id,
      name: id,
      activation: "enabled",
      package: String(model.package ?? "omp"),
      settings: {},
      headers: {},
    })
  }
  return [...seen.values()]
}

const AGENTS = [
  {
    id: "build",
    name: "Build",
    request: { settings: {}, headers: {}, body: {} },
    description: "The default agent. Executes tools based on configured permissions.",
    mode: "primary",
    hidden: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  },
  {
    id: "plan",
    name: "Plan",
    request: { settings: {}, headers: {}, body: {} },
    description: "Read-only analysis and planning.",
    mode: "primary",
    hidden: false,
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "write", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "ask" },
    ],
  },
]

// Keep a stable reference so the UI's session list ordering matches storage.
void now

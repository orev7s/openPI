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

  // Worktrees are project-scoped and owned here so the UI never hits the
  // upstream's project database. openPI keeps no worktrees.
  if (path === "/api/worktree" && method === "GET") {
    sendJson(res, 200, [])
    return true
  }
  if (path === "/api/worktree" && (method === "POST" || method === "DELETE")) {
    res.writeHead(204).end()
    return true
  }
  if (path === "/api/worktree/refresh" && method === "POST") {
    res.writeHead(204).end()
    return true
  }

  if (path === "/api/session" && method === "GET") {
    sendJson(res, 200, { data: listSessions(ctx), cursor: {} })
    return true
  }

  if (path === "/api/session" && method === "POST") {
    const body = await readJson(req)
    sendJson(res, 200, { data: ctx.manager.createSession(body as never) })
    return true
  }

  // Any /api/session/<id>/... is owned here: the session lives in openPI, so
  // the upstream cannot answer for it.
  if (path.startsWith("/api/session/")) {
    await handleSession(ctx, method)
    return true
  }

  return false
}

function listSessions(ctx: RouteContext): unknown[] {
  const parentID = ctx.url.searchParams.get("parentID")
  const order = ctx.url.searchParams.get("order") ?? "desc"
  const limit = Number(ctx.url.searchParams.get("limit") ?? "0")
  let sessions = ctx.manager.listSessions() as Record<string, unknown>[]
  if (parentID !== null) {
    // openPI never creates child sessions, so a parent filter matches nothing.
    sessions = parentID === "null" ? sessions : []
  }
  if (order === "asc") sessions = [...sessions].reverse()
  if (Number.isFinite(limit) && limit > 0) sessions = sessions.slice(0, limit)
  return sessions
}

async function handleSession(ctx: RouteContext, method: string): Promise<void> {
  const { req, res, manager, url } = ctx
  const rest = url.pathname.slice("/api/session/".length)
  const slash = rest.indexOf("/")
  const id = slash === -1 ? rest : rest.slice(0, slash)
  const action = slash === -1 ? undefined : rest.slice(slash + 1)

  if (!manager.getSession(id)) {
    sendError(res, 404, "SessionNotFoundError", `Session not found: ${id}`)
    return
  }

  if (action === undefined) {
    if (method === "GET") {
      sendJson(res, 200, { data: manager.getSession(id) })
      return
    }
    if (method === "PATCH") {
      const body = await readJson(req)
      if (typeof body.title === "string") manager.renameSession(id, body.title)
      res.writeHead(204).end()
      return
    }
    if (method === "DELETE") {
      await manager.deleteSession(id)
      res.writeHead(204).end()
      return
    }
  }

  switch (action) {
    case "prompt": {
      const body = await readJson(req)
      const data = await manager.prompt(id, body as never)
      sendJson(res, 200, { data })
      return
    }
    case "message": {
      sendJson(res, 200, { data: orderedMessages(ctx, id), cursor: {} })
      return
    }
    case "context": {
      sendJson(res, 200, { data: manager.messages(id) ?? [] })
      return
    }
    case "interrupt": {
      await manager.interrupt(id)
      res.writeHead(204).end()
      return
    }
    case "model": {
      const body = await readJson(req)
      const ref = body.model as { id?: unknown; providerID?: unknown; variant?: unknown } | undefined
      if (ref && typeof ref.id === "string" && typeof ref.providerID === "string") {
        await manager.setModel(id, {
          id: ref.id,
          providerID: ref.providerID,
          ...(typeof ref.variant === "string" ? { variant: ref.variant } : {}),
        })
      }
      res.writeHead(204).end()
      return
    }
    case "view":
    case "revert":
      res.writeHead(204).end()
      return
    case "inbox":
    case "permission":
    case "form":
    case "diff":
    case "log":
      sendJson(res, 200, { data: [] })
      return
    default: {
      if (action?.startsWith("inbox/")) {
        if (method === "DELETE") manager.cancelInbox(id, action.slice("inbox/".length))
        res.writeHead(204).end()
        return
      }
      // Unknown session sub-resource: answer with a shape the UI can consume
      // instead of letting the upstream's 404 crash the app.
      if (method === "GET") sendJson(res, 200, { data: [] })
      else res.writeHead(204).end()
      return
    }
  }
}

function orderedMessages(ctx: RouteContext, id: string): unknown[] {
  let messages = ctx.manager.messages(id) ?? []
  const order = ctx.url.searchParams.get("order") ?? "asc"
  const limit = Number(ctx.url.searchParams.get("limit") ?? "0")
  if (order === "desc") messages = [...messages].reverse()
  if (Number.isFinite(limit) && limit > 0) messages = messages.slice(0, limit)
  return messages
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

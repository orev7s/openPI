import type { IncomingMessage, ServerResponse } from "node:http"

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function sendError(res: ServerResponse, status: number, tag: string, message: string): void {
  sendJson(res, status, { _tag: tag, message })
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return {}
  }
}

export function locationOf(directory: string): { directory: string } {
  return { directory }
}

export function withLocation(directory: string, data: unknown): Record<string, unknown> {
  return { location: locationOf(directory), data }
}

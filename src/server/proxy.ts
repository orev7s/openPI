import type { IncomingMessage, ServerResponse } from "node:http"
import { request as httpRequest } from "node:http"

// Streams a request to the upstream and streams the response back unchanged.
export function proxy(req: IncomingMessage, res: ServerResponse, upstreamUrl: string, password?: string): void {
  const base = new URL(upstreamUrl)
  const headers: Record<string, string | string[]> = { ...req.headers } as Record<string, string | string[]>
  headers.host = base.host
  if (password !== undefined) headers.authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

  const proxied = httpRequest(
    {
      hostname: base.hostname,
      port: base.port,
      path: req.url,
      method: req.method,
      headers,
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    },
  )

  proxied.on("error", () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })

  req.pipe(proxied)
}

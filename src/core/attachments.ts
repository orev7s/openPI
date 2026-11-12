// Prompt attachments arrive as OpenCode `PromptInput.FileAttachment`s, which
// carry only a `uri`. Two consumers need more than that:
//
// - the UI renders and decodes user messages/inbox items as
//   `Prompt.FileAttachment` (`{ data, mime, source }`); a bare `{ uri }` fails
//   the schema and the image renderer reads `file.mime.startsWith(...)`, so it
//   throws and breaks the whole session;
// - OMP takes images on the prompt itself as `ImageContent` (`{ type: "image",
//   data, mimeType }`).
//
// This module resolves a `uri` (inline `data:`, `file:`, or a filesystem path)
// into base64 bytes once, then produces both shapes. `repairStoredMessages`
// upgrades transcripts written before this existed, so already-broken sessions
// recover instead of having to be recreated.

import { readFileSync, statSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Mirrors OpenCode's own 20 MiB attachment cap. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** Cap on inlined textual attachment content. */
export const MAX_INLINE_TEXT_CHARS = 200_000

/** Image mime types OMP accepts on a prompt. */
const OMP_IMAGE_MIMES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
  "image/bmp": true,
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  jsonc: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/typescript",
  mts: "text/typescript",
  tsx: "text/typescript",
  sh: "application/x-sh",
  sql: "application/sql",
  log: "text/plain",
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export interface MaterializedFile {
  data: string
  mime: string
  source: { type: "inline" } | { type: "uri"; uri: string }
  name?: string
  description?: string
  mention?: { start: number; end: number; text: string }
}

export interface OmpImage {
  type: "image"
  data: string
  mimeType: string
}

export interface MaterializedAttachments {
  /** Attachments in the `Prompt.FileAttachment` shape the UI decodes. */
  files: MaterializedFile[]
  /** Image attachments OMP accepts on a prompt. */
  images: OmpImage[]
  /** Text appended to the model prompt for non-image attachments. */
  context: string
}

interface AttachmentInput {
  uri: string
  name?: string
  description?: string
  mention?: MaterializedFile["mention"]
}

interface ResolvedBytes {
  bytes: Buffer
  mime?: string
  source: MaterializedFile["source"]
}

export function isTextualMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true
  return ["application/json", "application/xml", "application/yaml", "application/toml", "application/x-sh", "application/sql"].includes(
    mime,
  )
}

export function mimeFromPath(path: string): string | undefined {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return undefined
  return MIME_BY_EXTENSION[path.slice(dot + 1).toLowerCase()]
}

function parseDataUri(uri: string): { bytes: Buffer; mime?: string } {
  const comma = uri.indexOf(",")
  if (comma === -1) throw new Error("invalid data uri")
  const header = uri.slice(5, comma)
  const body = uri.slice(comma + 1)
  const parts = header.split(";")
  const mime = parts[0] ? parts[0].toLowerCase() : undefined
  const base64 = parts.some((part) => part.toLowerCase() === "base64")
  if (base64 && !BASE64_PATTERN.test(body)) throw new Error("non-canonical base64")
  const bytes = base64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8")
  return { bytes, mime }
}

function localPath(uri: string, directory: string): string | undefined {
  if (uri.startsWith("file:")) return fileURLToPath(new URL(uri))
  // A scheme other than `file:` (http, https, blob, ...) is not readable here.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return undefined
  const clean = uri.split(/[?#]/)[0]
  return isAbsolute(clean) ? clean : resolve(directory, clean)
}

function readMention(value: unknown): MaterializedFile["mention"] {
  if (!value || typeof value !== "object") return undefined
  const mention = value as { start?: unknown; end?: unknown; text?: unknown }
  if (typeof mention.start !== "number" || typeof mention.end !== "number" || typeof mention.text !== "string") return undefined
  return { start: mention.start, end: mention.end, text: mention.text }
}

function parseInput(raw: unknown): AttachmentInput | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const input = raw as { uri?: unknown; name?: unknown; description?: unknown; mention?: unknown }
  if (typeof input.uri !== "string" || input.uri === "") return undefined
  const mention = readMention(input.mention)
  return {
    uri: input.uri,
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    ...(mention ? { mention } : {}),
  }
}

function build(input: AttachmentInput, resolved: ResolvedBytes) {
  const { bytes } = resolved
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return undefined
  const mime = resolved.mime ?? "application/octet-stream"
  const data = bytes.toString("base64")
  const file: MaterializedFile = {
    data,
    mime,
    source: resolved.source,
    ...(input.name ? { name: input.name } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.mention ? { mention: input.mention } : {}),
  }
  const label = input.name ?? "attachment"
  const image = OMP_IMAGE_MIMES[mime] ? { type: "image" as const, data, mimeType: mime } : undefined
  let context = ""
  if (!image) {
    context = isTextualMime(mime)
      ? `Attached file: ${label}\n${bytes.toString("utf8").slice(0, MAX_INLINE_TEXT_CHARS)}`
      : `Attached file: ${label} (${mime}, ${bytes.byteLength} bytes)`
  }
  return { file, image, context }
}

async function resolveBytes(input: AttachmentInput, directory: string): Promise<ResolvedBytes | undefined> {
  if (input.uri.startsWith("data:")) {
    const parsed = parseDataUri(input.uri)
    return { bytes: parsed.bytes, mime: parsed.mime, source: { type: "inline" } }
  }
  const path = localPath(input.uri, directory)
  if (!path) return undefined
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) return undefined
  return { bytes: await readFile(path), mime: mimeFromPath(path), source: { type: "uri", uri: pathToFileURL(path).href } }
}

function resolveBytesSync(input: AttachmentInput, directory: string): ResolvedBytes | undefined {
  if (input.uri.startsWith("data:")) {
    const parsed = parseDataUri(input.uri)
    return { bytes: parsed.bytes, mime: parsed.mime, source: { type: "inline" } }
  }
  const path = localPath(input.uri, directory)
  if (!path) return undefined
  const info = statSync(path)
  if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) return undefined
  return { bytes: readFileSync(path), mime: mimeFromPath(path), source: { type: "uri", uri: pathToFileURL(path).href } }
}

export async function materializeAttachments(files: unknown[], directory: string): Promise<MaterializedAttachments> {
  const result: MaterializedAttachments = { files: [], images: [], context: "" }
  const context: string[] = []
  for (const raw of Array.isArray(files) ? files : []) {
    const input = parseInput(raw)
    if (!input) continue
    const resolved = await resolveBytes(input, directory).catch(() => undefined)
    if (!resolved) continue
    const built = build(input, resolved)
    if (!built) continue
    result.files.push(built.file)
    if (built.image) result.images.push(built.image)
    if (built.context) context.push(built.context)
  }
  result.context = context.length > 0 ? `\n\n${context.join("\n\n")}` : ""
  return result
}

export function isMaterializedFile(value: unknown): value is MaterializedFile {
  if (!value || typeof value !== "object") return false
  const file = value as { data?: unknown; mime?: unknown; source?: unknown }
  return typeof file.data === "string" && typeof file.mime === "string" && !!file.source && typeof file.source === "object"
}

/** Upgrades one stored attachment to the decodable shape; drops what it cannot read. */
export function repairStoredFile(raw: unknown, directory: string): MaterializedFile | undefined {
  if (isMaterializedFile(raw)) return raw
  const input = parseInput(raw)
  if (!input) return undefined
  const resolved = (() => {
    try {
      return resolveBytesSync(input, directory)
    } catch {
      return undefined
    }
  })()
  return resolved ? build(input, resolved)?.file : undefined
}

/**
 * Upgrades the user messages of a transcript in place. Returns true when
 * anything changed, so the caller can persist the repair.
 */
export function repairStoredMessages(messages: unknown, directory: string): boolean {
  if (!Array.isArray(messages)) return false
  let changed = false
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const record = message as { type?: unknown; files?: unknown }
    if (record.type !== "user" || !Array.isArray(record.files)) continue
    const files = record.files.map((file) => repairStoredFile(file, directory)).filter((file) => file !== undefined)
    if (files.length === record.files.length && files.every((file, index) => file === record.files![index])) continue
    record.files = files
    changed = true
  }
  return changed
}

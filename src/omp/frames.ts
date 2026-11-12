// JSONL framing for the OMP RPC channel. Protocol v1 is one JSON object per
// newline-terminated line. Protocol v2 splits a logical frame larger than
// maxFrameBytes into ordered rpc_chunk frames carrying base64 UTF-8 segments.

import { StringDecoder } from "node:string_decoder"

const DEFAULT_MAX_FRAME_BYTES = 1048576
const DEFAULT_MAX_REASSEMBLED_FRAME_BYTES = 67108864

const PENDING = Symbol("rpc_chunk_pending")

interface ChunkState {
  id: string
  count: number
  byteLength: number
  next: number
  size: number
  parts: Buffer[]
}

interface RpcChunkFrame {
  type: "rpc_chunk"
  chunkId: string | number
  index: number
  count: number
  byteLength: number
  data?: string
}

export function encodeFrame(value: unknown): string {
  return JSON.stringify(value) + "\n"
}

function isChunk(value: unknown): value is RpcChunkFrame {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "rpc_chunk"
}

export class RpcFrameDecoder {
  readonly #maxFrameBytes: number
  readonly #maxReassembledFrameBytes: number
  readonly #decoder = new StringDecoder("utf8")
  #buffer = ""
  #chunks: ChunkState | null = null

  constructor(options: { maxFrameBytes?: number; maxReassembledFrameBytes?: number } = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    this.#maxReassembledFrameBytes = options.maxReassembledFrameBytes ?? DEFAULT_MAX_REASSEMBLED_FRAME_BYTES
  }

  push(chunk: Buffer | string): unknown[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    this.#buffer += this.#decoder.write(bytes)
    const out: unknown[] = []
    for (;;) {
      const newline = this.#buffer.indexOf("\n")
      if (newline === -1) break
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "")
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.trim() === "") continue
      this.#ingest(this.#parseLine(line), out)
    }
    if (this.#buffer.length > this.#maxFrameBytes) {
      throw new Error(`rpc: incomplete frame exceeds maxFrameBytes (${this.#maxFrameBytes})`)
    }
    return out
  }

  #parseLine(line: string): unknown {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`rpc: malformed JSON frame: ${(error as Error).message}`)
    }
  }

  #ingest(value: unknown, out: unknown[]): void {
    if (!isChunk(value)) {
      if (this.#chunks) throw new Error("rpc: chunk sequence interrupted by a non-chunk frame")
      out.push(value)
      return
    }
    const done = this.#ingestChunk(value)
    if (done !== PENDING) out.push(done)
  }

  #ingestChunk(frame: RpcChunkFrame): unknown {
    const id = String(frame.chunkId)
    const { index, count, byteLength } = frame
    if (!Number.isInteger(count) || count < 1) throw new Error(`rpc_chunk: invalid count ${count}`)
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`rpc_chunk: invalid index ${index} for count ${count}`)
    }
    if (!Number.isInteger(byteLength) || byteLength < 0) throw new Error(`rpc_chunk: invalid byteLength ${byteLength}`)
    if (byteLength > this.#maxReassembledFrameBytes) {
      throw new Error(`rpc_chunk: byteLength ${byteLength} exceeds maxReassembledFrameBytes (${this.#maxReassembledFrameBytes})`)
    }

    let state = this.#chunks
    if (!state) {
      if (index !== 0) throw new Error(`rpc_chunk: sequence for ${id} started at index ${index}, expected 0`)
      state = { id, count, byteLength, next: 0, size: 0, parts: [] }
      this.#chunks = state
    } else {
      if (state.id !== id) throw new Error(`rpc_chunk: chunkId changed from ${state.id} to ${id} mid-sequence`)
      if (state.count !== count) throw new Error(`rpc_chunk: count changed from ${state.count} to ${count} mid-sequence`)
      if (state.byteLength !== byteLength) {
        throw new Error(`rpc_chunk: byteLength changed from ${state.byteLength} to ${byteLength} mid-sequence`)
      }
      if (index !== state.next) throw new Error(`rpc_chunk: expected index ${state.next}, got ${index}`)
    }

    const segment = Buffer.from(frame.data ?? "", "base64")
    state.parts.push(segment)
    state.size += segment.length
    state.next = index + 1

    if (state.size > this.#maxReassembledFrameBytes) {
      this.#chunks = null
      throw new Error(`rpc_chunk: reassembled frame exceeds maxReassembledFrameBytes (${this.#maxReassembledFrameBytes})`)
    }
    if (state.next < state.count) return PENDING

    this.#chunks = null
    if (state.size !== state.byteLength) {
      throw new Error(`rpc_chunk: reassembled ${state.size} bytes, expected ${state.byteLength}`)
    }
    try {
      return JSON.parse(Buffer.concat(state.parts).toString("utf8"))
    } catch (error) {
      throw new Error(`rpc_chunk: malformed JSON payload: ${(error as Error).message}`)
    }
  }
}

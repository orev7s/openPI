// Pending OpenCode "forms" owned by openPI.
//
// The vendored OpenCode v2 UI renders a pending form as a dock in the
// composer: a form whose `metadata.kind` is `"question"` opens the question
// dock, `"mcp-elicitation"` the elicitation dock, and `"websearch.provider"`
// the provider dock. A form nobody answers would leave the engine waiting, so
// every open form is backed by a promise the caller (the OMP UI bridge) awaits
// and every path that can end the request settles it exactly once.
//
// Forms are ephemeral: they are published to the SSE feed for the live UI, are
// never written to the session transcript, and do not survive a restart.

import type { SessionEventEnvelope } from "../omp/types.ts"
import type { Feed } from "./feed.ts"
import { eventID } from "./ids.ts"

export interface FormOption {
  value: string
  label: string
  description?: string
}

export interface FormField {
  key: string
  title?: string
  description?: string
  required?: boolean
  type: "string" | "multiselect"
  options?: FormOption[]
  custom?: boolean
}

export interface FormInfo {
  id: string
  sessionID: string
  title: string
  metadata: Record<string, unknown>
  fields: FormField[]
}

export type FormValue = string | number | boolean | string[]
export type FormAnswer = Record<string, FormValue>

/** What the asker learns once the dock is answered, dismissed or timed out. */
export type FormOutcome =
  | { status: "answered"; answer: FormAnswer }
  | { status: "cancelled"; message?: string; timedOut?: boolean }

export interface FormDetail extends FormInfo {
  state: FormOutcome | { status: "pending" }
}

export interface AskInput {
  sessionID: string
  location: { directory: string }
  title: string
  metadata: Record<string, unknown>
  fields: FormField[]
  /** Auto-dismiss after this many milliseconds; omitted means it waits forever. */
  timeoutMs?: number
}

interface Pending {
  info: FormInfo
  location: { directory: string }
  settle: (outcome: FormOutcome) => void
  timer?: NodeJS.Timeout
}

let counter = 0

function formID(): string {
  counter = (counter + 1) % 0xffff
  return "frm_" + Date.now().toString(36) + counter.toString(36).padStart(4, "0")
}

export class Forms {
  #feed: Feed
  #pending = new Map<string, Pending>()

  constructor(feed: Feed) {
    this.#feed = feed
  }

  /**
   * Open a form and resolve when the UI answers, dismisses or it times out.
   * The returned `id` names the form in the reply/cancel routes.
   */
  ask(input: AskInput): { id: string; outcome: Promise<FormOutcome> } {
    const info: FormInfo = {
      id: formID(),
      sessionID: input.sessionID,
      title: input.title,
      metadata: input.metadata,
      fields: input.fields,
    }
    const { promise, resolve } = Promise.withResolvers<FormOutcome>()
    const pending: Pending = { info, location: input.location, settle: resolve }
    this.#pending.set(info.id, pending)
    if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        this.#settle(info.id, { status: "cancelled", message: "timed out", timedOut: true })
      }, input.timeoutMs)
      pending.timer.unref()
    }
    this.#publish(input.location, "form.created", { form: info })
    return { id: info.id, outcome: promise }
  }

  /** Pending forms, newest last; `sessionID` narrows it to one session. */
  list(sessionID?: string, directory?: string): FormInfo[] {
    const infos: FormInfo[] = []
    for (const pending of this.#pending.values()) {
      if (sessionID !== undefined && pending.info.sessionID !== sessionID) continue
      if (directory !== undefined && pending.location.directory !== directory) continue
      infos.push(pending.info)
    }
    return infos
  }

  detail(sessionID: string, id: string): FormDetail | undefined {
    const info = this.#pending.get(id)?.info
    if (!info || info.sessionID !== sessionID) return undefined
    return { ...info, state: { status: "pending" } }
  }

  has(id: string): boolean {
    return this.#pending.has(id)
  }

  /** Answer a pending form. Returns false when it is unknown or already settled. */
  reply(sessionID: string, id: string, answer: FormAnswer): boolean {
    const pending = this.#pending.get(id)
    if (!pending || pending.info.sessionID !== sessionID) return false
    this.#settle(id, { status: "answered", answer })
    return true
  }

  /** Dismiss a pending form. Returns false when it is unknown or already settled. */
  cancel(sessionID: string, id: string, message?: string): boolean {
    const pending = this.#pending.get(id)
    if (!pending || pending.info.sessionID !== sessionID) return false
    this.#settle(id, { status: "cancelled", ...(message ? { message } : {}) })
    return true
  }

  /** Dismiss every form a session is waiting on, e.g. after an abort or a shutdown. */
  cancelSession(sessionID: string, message?: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.info.sessionID !== sessionID) continue
      this.#settle(id, { status: "cancelled", ...(message ? { message } : {}) })
    }
  }

  #settle(id: string, outcome: FormOutcome): void {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if (outcome.status === "answered") {
      this.#publish(pending.location, "form.replied", {
        id,
        sessionID: pending.info.sessionID,
        answer: outcome.answer,
      })
    } else {
      this.#publish(pending.location, "form.cancelled", { id, sessionID: pending.info.sessionID })
    }
    pending.settle(outcome)
  }

  #publish(location: { directory: string }, type: string, data: Record<string, unknown>): void {
    const envelope: SessionEventEnvelope = { id: eventID(), created: Date.now(), type, location, data }
    this.#feed.publish(envelope)
  }
}

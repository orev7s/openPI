// OMP extension-UI dialogs -> OpenCode forms.
//
// OMP's RPC mode can ask its host for input: `ask` (one request carrying every
// question of an extension `ui.askDialog` call, after `set_ask_dialog` opts in)
// and the single-dialog methods `select`, `editor`, `input` and `confirm` that
// OMP's `ask` tool walks an HTML form with over RPC, and which tool approvals
// and extensions use directly. The vendored OpenCode UI has no dialog surface of
// its own; it renders *forms*, so each dialog becomes a form whose
// `metadata.kind` is `"question"` and whose fields the question dock walks in
// order.
//
// Answers come back as the form's `answer` record keyed by field key
// (`q0`, `q1`, ...); `encode` turns that back into the answer frame OMP
// expects. Question order, option order and labels are preserved: labels are
// what OMP matches option selections against, so a displayed label may carry a
// marker while the option `value` stays the untouched label.

import type { FormAnswer, FormField, FormOption } from "../core/forms.ts"
import type { OmpEvent } from "./types.ts"

/** A dialog this bridge renders as a form. */
export interface UiFormPlan {
  kind: "form"
  title: string
  metadata: Record<string, unknown>
  fields: FormField[]
  timeoutMs?: number
  /** The `extension_ui_response` body for an answered form. */
  encode(answer: FormAnswer): Record<string, unknown>
}

/**
 * How to answer a request: open a form, or answer it cancelled at once when the
 * request carries nothing renderable. `undefined` means the frame needs no
 * answer at all (a presentation update, or a method another path owns).
 */
export type UiPlan = UiFormPlan | { kind: "cancel" }

// Fire-and-forget presentation methods: no response, nothing to render.
const PRESENTATION: Record<string, true> = {
  notify: true,
  setStatus: true,
  setWidget: true,
  setTitle: true,
  set_editor_text: true,
  open_url: true,
}

const RECOMMENDED_SUFFIX = " (Recommended)"
const CHECKED_SUFFIX = " (Selected)"

interface Question {
  id: string
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multi: boolean
  /** Index of the option to recommend, hoisted to the front of the dock list. */
  recommended?: number
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

// OMP validates `ask` answers positionally and by id, so a question is never
// dropped: one dropped question misaligns every answer after it and the engine
// rejects the whole response. Only a question without an id is unanswerable,
// and that fails the request as a cancellation rather than as a malformed
// answer array.
function questionsOf(event: OmpEvent): Question[] | undefined {
  const list = Array.isArray(event.questions) ? event.questions : []
  const questions: Question[] = []
  for (const [index, entry] of list.entries()) {
    const question = record(entry)
    const id = str(question?.id)
    if (!id) return undefined
    const header = str(question?.header)
    const options = (Array.isArray(question?.options) ? question!.options : []).flatMap((option) => {
      const parsed = record(option)
      const label = str(parsed?.label)
      if (!label) return []
      const description = str(parsed?.description)
      return [description ? { label, description } : { label }]
    })
    const recommended =
      typeof question?.recommended === "number" && question.recommended >= 0 && question.recommended < options.length
        ? question.recommended
        : undefined
    questions.push({
      id,
      question: str(question?.question) ?? header ?? `Question ${index + 1}`,
      ...(header ? { header } : {}),
      options,
      multi: question?.multi === true,
      ...(recommended !== undefined ? { recommended } : {}),
    })
  }
  return questions
}

/** The recommended option leads the list, labelled, without changing its value. */
function optionsOf(question: Question): FormOption[] {
  const options = question.options.map((option, index) => ({
    value: option.label,
    label: index === question.recommended ? option.label + RECOMMENDED_SUFFIX : option.label,
    ...(option.description ? { description: option.description } : {}),
  }))
  const recommended = question.recommended
  if (recommended === undefined) return options
  const [first] = options.splice(recommended, 1)
  return first ? [first, ...options] : options
}

/** Whatever the dock submitted, as a list, plus whether it came from the option list. */
function splitAnswer(question: Question, value: unknown): { chosen: string[]; custom: string[] } {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value]
  const items = raw.filter((item): item is string => typeof item === "string").map((item) => item.trim())
  const labels = new Set(question.options.map((option) => option.label))
  const chosen: string[] = []
  const custom: string[] = []
  for (const item of items) {
    if (!item) continue
    ;(labels.has(item) ? chosen : custom).push(item)
  }
  return { chosen, custom }
}

function askPlan(event: OmpEvent, requestID: string): UiPlan {
  const questions = questionsOf(event)
  if (!questions || questions.length === 0) return { kind: "cancel" }
  const fields: FormField[] = questions.map((question, index) => ({
    key: `q${index}`,
    ...(question.header ? { title: question.header } : {}),
    description: question.question,
    type: question.multi ? "multiselect" : "string",
    options: optionsOf(question),
    custom: true,
  }))
  return {
    kind: "form",
    title: str(event.title) ?? "Questions",
    metadata: { kind: "question", omp: { id: requestID, method: "ask" } },
    fields,
    ...(typeof event.timeout === "number" && event.timeout > 0 ? { timeoutMs: event.timeout } : {}),
    encode: (answer) => ({
      answers: questions.map((question, index) => {
        const { chosen, custom } = splitAnswer(question, answer[`q${index}`])
        if (question.multi) {
          return {
            id: question.id,
            selectedOptions: chosen,
            ...(custom.length > 0 ? { customInput: custom.join(", ") } : {}),
          }
        }
        // A single select takes at most one option and never an option plus free text.
        if (chosen.length > 0) return { id: question.id, selectedOptions: [chosen[0]] }
        return { id: question.id, selectedOptions: [], ...(custom[0] ? { customInput: custom[0] } : {}) }
      }),
    }),
  }
}

// One dialog, one field: the dock shows it as the only question of the form.
function singleFieldPlan(
  event: OmpEvent,
  requestID: string,
  field: FormField,
  encode: (value: string | undefined) => Record<string, unknown>,
): UiFormPlan {
  return {
    kind: "form",
    title: str(event.title) ?? "Input",
    metadata: { kind: "question", omp: { id: requestID, method: String(event.method) } },
    fields: [field],
    ...(typeof event.timeout === "number" && event.timeout > 0 ? { timeoutMs: event.timeout } : {}),
    encode: (answer) => {
      const raw = answer[field.key]
      const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined
      return encode(value)
    },
  }
}

// Rows the engine reports as already checked in a checkbox loop. Only the first
// `markableCount` rows carry marks; the rest are actions ("Done selecting").
function checkedRows(event: OmpEvent): Set<number> {
  if (event.selectionMarker !== "checkbox" || !Array.isArray(event.checkedIndices)) return new Set()
  const markable = typeof event.markableCount === "number" ? event.markableCount : Number.POSITIVE_INFINITY
  const rows = new Set<number>()
  for (const index of event.checkedIndices) {
    if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < markable) rows.add(index)
  }
  return rows
}

function selectPlan(event: OmpEvent, requestID: string): UiPlan {
  const labels = (Array.isArray(event.options) ? event.options : []).filter(
    (option): option is string => typeof option === "string",
  )
  if (labels.length === 0) return { kind: "cancel" }
  const details = Array.isArray(event.optionDetails) ? event.optionDetails : []
  const checked = checkedRows(event)
  const options = labels.map((label, index) => {
    const description = str(record(details[index])?.description)
    return {
      // The dock cannot carry a mark across the engine's repeated dialogs, so a
      // row the engine already has checked says so in its label. The value stays
      // the engine's own row, which is what it matches the answer against.
      value: label,
      label: checked.has(index) ? label + CHECKED_SUFFIX : label,
      ...(description ? { description } : {}),
    }
  })
  // The engine's own rows travel verbatim: its "Other (type your own)" row is
  // what triggers the free-text dialog it asks next, and its "Done selecting"
  // row is the only way to end a checkbox group.
  return singleFieldPlan(
    event,
    requestID,
    { key: "q0", description: str(event.title), type: "string", options, custom: true },
    (value) => (value ? { value } : { cancelled: true }),
  )
}

function textPlan(event: OmpEvent, requestID: string): UiPlan {
  return singleFieldPlan(
    event,
    requestID,
    {
      key: "q0",
      title: str(event.title),
      description: str(event.message) ?? str(event.placeholder),
      type: "string",
      custom: true,
    },
    (value) => (value ? { value } : { cancelled: true }),
  )
}

function confirmPlan(event: OmpEvent, requestID: string): UiPlan {
  return singleFieldPlan(
    event,
    requestID,
    {
      key: "q0",
      title: str(event.title),
      description: str(event.message),
      type: "string",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    },
    (value) => ({ confirmed: value === "yes" }),
  )
}

/**
 * The plan for one `extension_ui_request`. `requestID` is the frame's `id`,
 * echoed back in the response.
 */
export function planUiRequest(event: OmpEvent, requestID: string): UiPlan | undefined {
  const method = typeof event.method === "string" ? event.method : ""
  if (PRESENTATION[method] === true) return undefined
  switch (method) {
    case "ask":
      return askPlan(event, requestID)
    case "select":
      return selectPlan(event, requestID)
    case "editor":
    case "input":
      return textPlan(event, requestID)
    case "confirm":
      return confirmPlan(event, requestID)
    default:
      // A dialog we do not know how to render: answer instead of leaving the
      // engine waiting on a request nobody will ever complete.
      return { kind: "cancel" }
  }
}

/** The response body for a form the user dismissed, in the request's own shape. */
export function cancelledResponse(event: OmpEvent, timedOut = false): Record<string, unknown> {
  if (event.method === "confirm") return { confirmed: false }
  return { cancelled: true, ...(timedOut ? { timedOut: true } : {}) }
}

// The OMP dialog -> form mapping: which request becomes which form, and how a
// dock answer turns back into the answer frame OMP expects.

import { test } from "node:test"
import assert from "node:assert/strict"
import { cancelledResponse, planUiRequest, type UiFormPlan } from "../src/omp/ui-forms.ts"
import type { OmpEvent } from "../src/omp/types.ts"

function form(event: OmpEvent): UiFormPlan {
  const plan = planUiRequest(event, "ui_1")
  assert.ok(plan?.kind === "form", `expected a form plan, got ${JSON.stringify(plan)}`)
  return plan
}

test("an ask dialog becomes one field per question, in order", () => {
  const plan = form({
    type: "extension_ui_request",
    method: "ask",
    id: "ui_1",
    title: "Questions",
    timeout: 5000,
    questions: [
      {
        id: "db",
        question: "Which database?",
        header: "Database",
        options: [{ label: "Postgres" }, { label: "SQLite", description: "a file" }],
        recommended: 1,
      },
      { id: "features", question: "Which features?", multi: true, options: [{ label: "Auth" }, { label: "Billing" }] },
    ],
  })

  assert.equal(plan.title, "Questions")
  assert.equal(plan.timeoutMs, 5000)
  assert.deepEqual(plan.metadata, { kind: "question", omp: { id: "ui_1", method: "ask" } })
  assert.deepEqual(
    plan.fields.map((field) => field.key),
    ["q0", "q1"],
  )
  assert.equal(plan.fields[0].title, "Database")
  assert.equal(plan.fields[0].description, "Which database?")
  assert.equal(plan.fields[0].type, "string")
  assert.equal(plan.fields[0].custom, true)
  assert.equal(plan.fields[1].type, "multiselect")

  // Recommending hoists the option and marks its label, never its value: OMP
  // matches the answer against the option labels it sent.
  assert.deepEqual(
    plan.fields[0].options?.map((option) => option.value),
    ["SQLite", "Postgres"],
  )
  assert.deepEqual(
    plan.fields[0].options?.map((option) => option.label),
    ["SQLite (Recommended)", "Postgres"],
  )
  assert.deepEqual(plan.fields[0].options?.[0].description, "a file")
  // Untouched question: options keep their order and labels.
  assert.deepEqual(plan.fields[1].options, [
    { value: "Auth", label: "Auth" },
    { value: "Billing", label: "Billing" },
  ])
})

test("ask answers are returned in request order, keyed back to the question ids", () => {
  const plan = form({
    type: "extension_ui_request",
    method: "ask",
    id: "ui_1",
    questions: [
      { id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], recommended: 0 },
      { id: "features", question: "Which features?", multi: true, options: [{ label: "Auth" }, { label: "Billing" }] },
    ],
  })

  assert.deepEqual(plan.encode({ q0: "SQLite", q1: ["Auth", "Billing"] }), {
    answers: [
      { id: "db", selectedOptions: ["SQLite"] },
      { id: "features", selectedOptions: ["Auth", "Billing"] },
    ],
  })

  // A free-text answer is not one of the offered labels, so it is the custom input.
  assert.deepEqual(plan.encode({ q0: "DuckDB", q1: [] }), {
    answers: [
      { id: "db", selectedOptions: [], customInput: "DuckDB" },
      { id: "features", selectedOptions: [] },
    ],
  })

  // Several free-text entries in a multi-select collapse into one custom input.
  assert.deepEqual(plan.encode({ q1: ["Auth", "dbt", "airflow"] }), {
    answers: [
      { id: "db", selectedOptions: [] },
      { id: "features", selectedOptions: ["Auth"], customInput: "dbt, airflow" },
    ],
  })

  // Nothing submitted: OMP sees an unanswered question rather than a guess.
  assert.deepEqual(plan.encode({}), {
    answers: [
      { id: "db", selectedOptions: [] },
      { id: "features", selectedOptions: [] },
    ],
  })

  // A single select never carries both an option and free text.
  assert.deepEqual(plan.encode({ q0: ["Postgres", "typed"] }), {
    answers: [
      { id: "db", selectedOptions: ["Postgres"] },
      { id: "features", selectedOptions: [] },
    ],
  })
})

test("a select dialog becomes a single-choice question", () => {
  const plan = form({
    type: "extension_ui_request",
    method: "select",
    id: "ui_2",
    title: "Pick a branch",
    options: ["main", "release"],
    optionDetails: [{ description: "the trunk" }],
  })

  // The question dock reads the text from the field, not the form title, and
  // every engine row is passed through untouched.
  assert.deepEqual(plan.fields, [
    {
      key: "q0",
      description: "Pick a branch",
      type: "string",
      options: [
        { value: "main", label: "main", description: "the trunk" },
        { value: "release", label: "release" },
      ],
      custom: true,
    },
  ])
  assert.deepEqual(plan.encode({ q0: "release" }), { value: "release" })
  assert.deepEqual(plan.encode({}), { cancelled: true })
})

test("the engine's own select rows survive as answer values", () => {
  const plan = form({
    type: "extension_ui_request",
    method: "select",
    id: "ui_2b",
    title: "(1 selected) Which features?",
    options: ["Auth", "Other (type your own)", "✔ Done selecting"],
  })

  assert.deepEqual(
    plan.fields[0].options?.map((option) => option.value),
    ["Auth", "Other (type your own)", "✔ Done selecting"],
  )
  assert.equal(plan.fields[0].description, "(1 selected) Which features?")
  assert.deepEqual(plan.encode({ q0: "✔ Done selecting" }), { value: "✔ Done selecting" })
})

test("editor, input and confirm dialogs each become a form field", () => {
  const editor = form({ type: "extension_ui_request", method: "editor", id: "ui_3", title: "Commit message", message: "Write one" })
  assert.deepEqual(editor.fields, [
    { key: "q0", title: "Commit message", description: "Write one", type: "string", custom: true },
  ])
  assert.deepEqual(editor.encode({ q0: "fix: thing" }), { value: "fix: thing" })

  const input = form({ type: "extension_ui_request", method: "input", id: "ui_4", title: "Branch name", placeholder: "feature/..." })
  assert.deepEqual(input.fields, [
    { key: "q0", title: "Branch name", description: "feature/...", type: "string", custom: true },
  ])

  const confirm = form({ type: "extension_ui_request", method: "confirm", id: "ui_5", title: "Delete?", message: "This cannot be undone" })
  assert.deepEqual(confirm.fields, [
    {
      key: "q0",
      title: "Delete?",
      description: "This cannot be undone",
      type: "string",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    },
  ])
  assert.deepEqual(confirm.encode({ q0: "yes" }), { confirmed: true })
  assert.deepEqual(confirm.encode({ q0: "no" }), { confirmed: false })
  assert.deepEqual(confirm.encode({}), { confirmed: false })
})

test("requests that cannot be rendered are answered, not left waiting", () => {
  assert.deepEqual(planUiRequest({ type: "extension_ui_request", method: "ask", id: "ui_6", questions: [] }, "ui_6"), { kind: "cancel" })
  assert.deepEqual(planUiRequest({ type: "extension_ui_request", method: "select", id: "ui_7", options: [] }, "ui_7"), { kind: "cancel" })
  assert.deepEqual(planUiRequest({ type: "extension_ui_request", method: "totallyNewDialog", id: "ui_8" }, "ui_8"), { kind: "cancel" })
})

test("a question without an id cancels instead of misaligning the answers", () => {
  // OMP requires one answer per question, in order and keyed by id, so a request
  // this host cannot answer in its own shape is cancelled rather than answered
  // with the wrong number of answers.
  assert.deepEqual(
    planUiRequest(
      {
        type: "extension_ui_request",
        method: "ask",
        id: "ui_12",
        questions: [{ question: "Which database?", options: [{ label: "Postgres" }] }],
      },
      "ui_12",
    ),
    { kind: "cancel" },
  )
})

test("a question with no text of its own keeps its place in the answer list", () => {
  const plan = form({
    type: "extension_ui_request",
    method: "ask",
    id: "ui_13",
    questions: [
      { id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
      { id: "features", options: [{ label: "Auth" }] },
    ],
  })

  assert.deepEqual(
    plan.fields.map((field) => field.key),
    ["q0", "q1"],
  )
  assert.equal(plan.fields[1].description, "Question 2")
  assert.deepEqual(plan.encode({ q0: "SQLite", q1: ["Auth"] }), {
    answers: [
      { id: "db", selectedOptions: ["SQLite"] },
      { id: "features", selectedOptions: ["Auth"] },
    ],
  })
})

test("a checkbox loop's checked rows are marked, and still answer as their own value", () => {
  const plan = form({
    type: "extension_ui_request",
    method: "select",
    id: "ui_14",
    title: "(2 selected) Which features?",
    options: ["Auth", "Billing", "Other (type your own)", "✔ Done selecting"],
    selectionMarker: "checkbox",
    checkedIndices: [0, 1, 3],
    markableCount: 3,
  })

  // The answer values stay exactly the engine's own rows; only the labels say
  // which are already checked. Index 3 is past markableCount, so it is an action.
  assert.deepEqual(
    plan.fields[0].options?.map((option) => option.value),
    ["Auth", "Billing", "Other (type your own)", "✔ Done selecting"],
  )
  assert.deepEqual(
    plan.fields[0].options?.map((option) => option.label),
    ["Auth (Selected)", "Billing (Selected)", "Other (type your own)", "✔ Done selecting"],
  )
  assert.deepEqual(plan.encode({ q0: "Billing" }), { value: "Billing" })
})

test("a plain select is not marked", () => {
  const plan = form({
    type: "extension_ui_request",
    method: "select",
    id: "ui_15",
    title: "Pick a branch",
    options: ["main", "release"],
    initialIndex: 1,
  })

  assert.deepEqual(
    plan.fields[0].options?.map((option) => option.label),
    ["main", "release"],
  )
})

test("presentation updates need no answer", () => {
  assert.equal(planUiRequest({ type: "extension_ui_request", method: "notify", id: "ui_9", message: "hi" }, "ui_9"), undefined)
  assert.equal(planUiRequest({ type: "extension_ui_request", method: "setTitle", id: "ui_10", title: "Named" }, "ui_10"), undefined)
  assert.equal(planUiRequest({ type: "extension_ui_request", method: "set_editor_text", id: "ui_11", text: "draft" }, "ui_11"), undefined)
})

test("a dismissed dialog answers in the shape its request expects", () => {
  assert.deepEqual(cancelledResponse({ type: "extension_ui_request", method: "confirm" }), { confirmed: false })
  assert.deepEqual(cancelledResponse({ type: "extension_ui_request", method: "ask" }), { cancelled: true })
  assert.deepEqual(cancelledResponse({ type: "extension_ui_request", method: "ask" }, true), { cancelled: true, timedOut: true })
  assert.deepEqual(cancelledResponse({ type: "extension_ui_request", method: "select" }, true), { cancelled: true, timedOut: true })
})

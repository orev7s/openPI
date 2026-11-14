# How an OMP tool becomes a card in the OpenCode UI

This is the concrete version of the *Mapping OMP -> OpenCode* section of
`ARCHITECTURE.md`. It follows one tool call from the pi/OMP engine all the way to
the card the vendored OpenCode v2 UI renders, and it ends with the exact edits
that make a **new** tool — including a custom tool the agent loads from
`~/.omp/agent/tools/*.ts` — render as a real card instead of the generic
fallback.

Every path below is real; nothing here is an invented API.

---

## 1. The pipeline

```
pi/OMP tool call
  tool_execution_start | tool_execution_update | tool_execution_end      (OMP RPC frames)
        -> src/omp/client.ts                       (JSONL framing, src/omp/frames.ts)
        -> src/core/manager.ts  #onEngineEvent
        -> src/omp/map.ts       EventTranslator.translate
        -> src/core/manager.ts  #emit -> src/core/feed.ts  Feed.publish
        -> src/server/routes.ts streamEvents       (GET /api/event, SSE)
        -> opencode/packages/client/src/solid/data.ts   (tool part state machine)
        -> opencode/packages/session-ui/src/message/current-message.tsx
        -> ToolDisplay -> ToolRegistry.render(name)
```

### 1.1 OMP emits the tool events

`omp --mode rpc` writes newline-delimited JSON on stdout. Every non-response
frame is an `OmpEvent` (`src/omp/types.ts:25`), an open record keyed by `type`.
The tool frames are, per `ARCHITECTURE.md` *OMP RPC contract*:

* `tool_execution_start` `{toolCallId, toolName, args}`
* `tool_execution_update` `{toolCallId, toolName, args, partialResult}`
* `tool_execution_end` `{toolCallId, toolName, result, isError}`

### 1.2 The manager feeds them to the translator

`src/core/manager.ts:364` constructs one `EventTranslator` per session, and
`#onEngineEvent` (`src/core/manager.ts:403-421`) runs every engine event through
`translate(...)`, then `#emit`s each returned envelope. `#emit`
(`src/core/manager.ts:615-619`) projects the envelope into message rows
(`projectIntoMessages`), publishes it on the feed (`this.#feed.publish`) and
persists durable envelopes.

### 1.3 `map.ts` translates one tool call into three event kinds

| OMP frame | Translator | OpenCode event |
| --- | --- | --- |
| `assistantMessageEvent.toolcall_start` | `onMessageUpdate`, `src/omp/map.ts:385-390` | `session.tool.input.started` (carries `name`) |
| `assistantMessageEvent.toolcall_delta/end` | `src/omp/map.ts:392-414` | `session.tool.input.delta` / `.ended` |
| `tool_execution_start` | `onToolExecutionStart`, `src/omp/map.ts:449-466` | `session.tool.called` |
| `tool_execution_update` | `onToolExecutionUpdate`, `src/omp/map.ts:468-479` | `session.tool.progress` |
| `tool_execution_end` | `onToolExecutionEnd`, `src/omp/map.ts:481-517` | `session.tool.success` / `session.tool.failed` |

`onToolExecutionStart` is the one that matters for card selection:

```ts
// src/omp/map.ts:449-466
private onToolExecutionStart(event: OmpEvent): SessionEventEnvelope[] {
  ...
  const rawName = typeof event.toolName === "string" ? event.toolName : ""
  const input = asRecord(event.args)
  ...
  return [
    this.durable("session.tool.called", {
      assistantMessageID: assistantID,
      id,
      name: rendererName(rawName, input),
      input: normalizeToolInput(rawName, input),
      executed: true,
    }),
  ]
}
```

Result text becomes `content` (`toTextContent`, `src/omp/map.ts:54-67`, images
dropped, always at least one text block) and `result.details` becomes
`metadata` on success. A failure produces `error: { type: "tool-error", message }`
(`src/omp/map.ts:496-505`).

### 1.4 Name normalization and the shape-based fallback

`rendererName(name, input)` (`src/omp/map.ts:164-187`) is the single decision
point for "which renderer does this call get". In order:

1. `TOOL_NAME_MAP` (`src/omp/map.ts:75-79`): `bash -> shell`, `task -> subagent`,
   `web_search -> websearch`. (`eval -> execute` is not in that table; `eval` is
   forwarded as-is and *registered* as `execute`'s sibling — see §3.3.)
2. `xdevDevice` (`src/omp/map.ts:142-149`): a `write` whose `path` starts with
   `xd://` renders under the **device** name, e.g. `write xd://bg` renders as `bg`.
3. `RENDERER_NAMES` (`src/omp/map.ts:84-100`): names the UI already has cards
   for (`read`, `list`, `glob`, `grep`, `webfetch`, `websearch`, `subagent`,
   `execute`, `shell`, `edit`, `write`, `patch`, `question`, `skill`) pass through.
4. `OMP_TOOL_NAMES` (`src/omp/map.ts:104-140`): OMP built-ins the fork renders by
   name (`eval`, `python`, `notebook`, `find`, `lsp`, `ast_grep`, `ast_edit`,
   `github`, `checkpoint`, `rewind`, `context_notes`, `new_context`,
   `security_scan`, `debug`, `ida`, `memory_edit`, `retain`, `recall`, `reflect`,
   `learn`, `manage_skill`, `browser`, `computer`, `image_gen`,
   `report_tool_issue`, `ask`, `run_code`, `todo`, `wait`, `bg`, `detach`,
   `report_issue`) pass through unchanged. This set exists so that a tool like
   `recall` (which takes a `query`) is not mistaken for a web search.
5. Shape inference, in this order (`src/omp/map.ts:176-186`): `input.command`
   -> `shell`, `input.code` -> `execute`, `input.url` -> `webfetch`,
   `input.query` -> `websearch`, `input.pattern` -> `grep`, and
   `input.path` -> `write` (has `content`) / `edit` (has `old_string` or
   `oldString`) / `read`.
6. Otherwise the raw tool name is returned.

`normalizeToolInput` (`src/omp/map.ts:151-162`) additionally renames OMP's
snake_case `edit` args to the camelCase the OpenCode `edit` card reads
(`old_string -> oldString`, `new_string -> newString`,
`replace_all -> replaceAll`).

`test/map.test.ts:192-226` is the executable specification of all of the above:
`eval` stays `eval`, `web_search` becomes `websearch`, `run_thing {command}` becomes
`shell`, `write {path:"xd://bg"}` becomes `bg`, and OMP's edit args come out
camelCase.

### 1.5 SSE

`src/server/routes.ts:45` owns `GET /api/event`; `streamEvents`
(`src/server/routes.ts:221-243`) subscribes to the feed and writes one
`data: <json>\n\n` line per envelope. This is the same envelope shape
`ARCHITECTURE.md` documents.

### 1.6 The UI turns events into a tool part

`opencode/packages/client/src/solid/data.ts` is the client state machine that
consumes the SSE events:

* `session.tool.input.started` (`:1059`) pushes a `tool` content part with
  `name: event.data.name` and `state: { status: "streaming", input: "" }`.
  **This is where the card's name is stored.** Note that
  `session.tool.called` has no `name` in the schema
  (`opencode/packages/schema/src/session-event.ts:512-524`) even though `map.ts`
  includes one; the client ignores it.
* `session.tool.input.delta` / `.ended` (`:1070`, `:1075`) fill the raw JSON text.
* `session.tool.called` (`:1080`) sets `status: "running"`, `input`, `executed`.
* `session.tool.progress` (`:1088`) replaces `metadata`.
* `session.tool.success` (`:1093`) sets `status: "completed"`, `content`
  (rendered as `output`) and `metadata`; `session.tool.failed` (`:1107`) sets
  `status: "error"` plus `error`.

So a tool part's `state.status` is one of `"streaming" | "running" | "completed"
| "error"` — the exact union `storyTool` uses in
`opencode/packages/session-ui/src/storybook/current-session-scenarios.ts:6`.

---

## 2. Where the card is looked up

`opencode/packages/session-ui/src/message/current-message.tsx:101-118` renders
each tool part:

```tsx
<ToolDisplay
  id={props.contentID}
  tool={tool().name}
  input={currentToolInput(tool())}
  metadata={currentToolMetadata(tool())}
  output={currentToolOutput(tool())}
  status={tool().state.status}
  error={currentToolError(tool())}
  defaultOpen={props.defaultOpen}
  open={props.toolOpen}
  onOpenChange={props.onToolOpenChange}
  deferContent
  virtualizeDiff={false}
  onContentRendered={props.onContentRendered}
/>
```

`ToolDisplay` (`opencode/packages/session-ui/src/tools/tool-renderer.tsx:1343`)
resolves the renderer once, on the normalized name:

```tsx
// tool-renderer.tsx:1371
const render = createMemo(() => ToolRegistry.render(props.tool) ?? GenericTool)
...
// tool-renderer.tsx:1415
<Dynamic component={render()} {...props} />
```

`ToolRegistry` is a plain module-level record
(`tool-renderer.tsx:1148-1169`):

```ts
const state: Record<string, { name: string; render?: ToolComponent }> = {}

function registerTool(input: { name: string; render?: ToolComponent }) { state[input.name] = input; return input }
function getTool(name: string) { return state[name]?.render }

export const ToolRegistry = { register: registerTool, render: getTool }
```

The registry is populated as a **side effect of importing
`tools/tool-renderer.tsx`**: the built-in cards call
`ToolRegistry.register({ name, render })` at module scope (`read` at `:1475`,
`list` `:1571`, `glob` `:1602`, `grep` `:1635`, `webfetch` `:1673`, `websearch`
`:1713`, `subagent` `:1738`, `execute` `:1928`, `shell` `:2255`, `edit` `:2383`,
`write` `:2469`, `patch` `:2509`, `question` `:2646`, `skill` `:2700`), and the
last statement of the file hands the registry to the OMP layer
(`tool-renderer.tsx:2735`):

```ts
registerOmpTools(ToolRegistry)
```

`registerOmpTools` (`opencode/packages/session-ui/src/tools/omp-tools.tsx:220-236`)
registers one renderer per entry in the `specs` table (`omp-tools.tsx:40-92`)
and then aliases the raw OMP names onto their native cards:

```ts
const aliases: Record<string, string> = { bash: "shell", task: "subagent", web_search: "websearch" }
for (const [alias, target] of Object.entries(aliases)) {
  const render = registry.render(target)
  if (render) registry.register({ name: alias, render })
}
```

Two more places read the tool name and therefore matter to a new tool:

* `toolTitle` (`tool-renderer.tsx:280-315`) — the collapsed group-header title.
  Its `default:` branch calls `ompToolTitle(name, i18n)`
  (`omp-tools.tsx:215-218`), which returns the spec's translated title when the
  name is in `specs`, else `undefined`, in which case the raw name is shown.
* `timelineCategory` (`opencode/packages/session-ui/src/timeline/detail.ts:101-113`)
  — decides the timeline bucket: `shell`/`execute`/`bash` -> `"shell"`,
  `edit`/`write`/`patch`/`apply_patch` -> `"edit"`, `subagent`/`task` ->
  `"subagents"`, everything else -> `"tools"`. Unregistered names therefore land
  in the generic *tools* grouping, which is what you want for a new tool.

Finally, `renderable` (`timeline/projection.ts:961-975`) hides a part entirely
while it streams if the name is `todowrite`, and hides `question` while its
status is `streaming`/`running`.

---

## 3. What a developer must do for a new tool

There are two sides, and **both** must agree on the exact name string.

### 3.1 Step 1 — make `map.ts` keep the name (only if the args could be mistaken)

If the tool's args include any of `command`, `code`, `url`, `query`, `pattern` or
`path`, the shape fallback in §1.4 will rename it and your card will never be
reached. Pin the name by adding it to `OMP_TOOL_NAMES` in
`src/omp/map.ts:104-140`:

```ts
const OMP_TOOL_NAMES = new Set([
  ...
  "ask_user",
])
```

Adding it there also means the name is forwarded even before any arguments are
parsed, which is what the `session.tool.input.started` name is computed from
(`src/omp/map.ts:388`). A tool whose args are entirely unlike the six shapes
above can skip this step, but do not rely on that — a later arg addition can
silently hijack the card.

### 3.2 Step 2 — register the card under that exact name

Two equivalent routes, both keyed on the same string:

**Route A — an OMP-flavoured card via the `specs` table** (cheapest; needs an
i18n key). Add an entry to `specs` in `omp-tools.tsx:40`:

```ts
const specs: Record<string, OmpToolSpec> = {
  ...
  ask_user: { icon: "bubble-5", title: "ui.tool.askUser" },
}
```

`OmpToolSpec` (`omp-tools.tsx:31-35`) is
`{ icon: IconProps["name"]; title: UiI18nOrdinaryKey; args?: (input) => string[] }`
and `registerOmpTools` (`omp-tools.tsx:220-223`) registers every key with the
`OmpTool` renderer (`omp-tools.tsx:95-150`). That renderer shows the icon, the
translated title, the optional `args`, and — as markdown — `input.code`,
`input.content` (used by xdev device dispatches) and `props.output`. The title
must exist in the dictionary: add `"ui.tool.askUser": "Ask user"` next to
`"ui.tool.ask"` in `opencode/packages/ui/src/i18n/en.ts:269`, because
`title` is typed `UiI18nOrdinaryKey`
(`opencode/packages/ui/src/context/i18n.tsx:18`). This route also fixes the
group-header title for free, since `ompToolTitle` reads `specs`
(`omp-tools.tsx:215-218`, used at `tool-renderer.tsx:313`).

**Route B — a hand-written card via the registry.** Append to the end of
`opencode/packages/session-ui/src/tools/tool-renderer.tsx`, before the closing
`registerOmpTools(ToolRegistry)` line (order matters: the aliases in
`registerOmpTools` resolve against already-registered renderers):

```ts
ToolRegistry.register({ name: "ask_user", render(props) { /* ... */ } })
```

### 3.3 The exact card signature

A card is a `Component<ToolProps>` and receives **all** of `ToolProps`
(`tool-renderer.tsx:1121-1144`), copied verbatim:

```ts
export interface ToolProps {
  input: Record<string, unknown>
  error?: string
  metadata: Record<string, unknown>
  tool: string
  sessionID?: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  fileOpen?: (path: string) => boolean | undefined
  onFileOpenChange?: (path: string, open: boolean) => void
  deferContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  pendingFiles?: readonly string[]
  forceOpen?: boolean
  locked?: boolean
}
```

`ToolDisplay` spreads the props it was given (`tool-renderer.tsx:1415`), so a
card is free to ignore the ones it does not use. In practice a card only needs
`input`, `metadata`, `output`, `status`, `defaultOpen`, `open`,
`onOpenChange` and `deferContent`, and it should:

* treat `props.status === "streaming" || props.status === "running"` as
  *pending* — that is exactly `BasicTool`'s own test
  (`opencode/packages/session-ui/src/components/basic-tool.tsx:114`), which
  drives the shimmer and blocks expanding while pending;
* render output only when `props.output` is set (see how the `question` card and
  `OmpTool` do it, and `GenericTool`'s `hasContent={!!props.output}`,
  `basic-tool.tsx:367`);
* never crash on missing data: `props.input`/`props.metadata` are open records
  (the `SAFETY` note above `ToolProps`), and existing cards decode defensively.

`BasicTool` is the house shell: pass `{...props}` plus `icon`,
`hasContent`, `trigger` and `children`. Its trigger is
`TriggerTitle` = `{ title, titleClass?, subtitle?, subtitleClass?, args?,
argsClass?, action? }` (`basic-tool.tsx:22-31`). Errors are handled *for* the
card: `ToolDisplay` renders `ToolErrorCard` when `toolDisplayError` returns
something (`tool-renderer.tsx:1466-1473`), which is `props.status === "error"`
for every tool except `execute`.

### 3.4 A real card to copy

The `question` card (`tool-renderer.tsx:2646-2698`) is the closest template for
a "ask the user something" tool, and it shows the whole pattern — input decoded
with the shared `toolInput` helper, the answer read from metadata, a computed
subtitle, and `defaultOpen` once answered:

```tsx
ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()

    const items = createMemo(() => questions(toolInput(props.input)))

    const answers = createMemo(() =>
      (toolMetadata(props.metadata).answers ?? []).flatMap((answer) => Option.toArray(decodeAnswer(answer))),
    )

    const completed = createMemo(() => answers().length > 0)

    const subtitle = createMemo(() => {
      const count = items().length
      if (count === 0) return ""
      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })
      return `${count} ${i18n.plural("ui.common.question", count)}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{ title: i18n.t("ui.tool.questions"), subtitle: subtitle() }}
      >
        ...
      </BasicTool>
    )
  },
})
```

Supporting pieces from the same file: `questions()` reads
`input.questions` as `{ question: string }[]` (`tool-renderer.tsx:167,181-183`),
`decodeAnswer` is `Schema.Array(Schema.String)` (`:169`), `toolInput` (`:119-140`)
and `toolMetadata` (`:143-...`) are *strict* decode-or-empty structs. `toolInput`
only allows `path, pattern, include, offset, limit, url, query, agent,
description, task, prompt, command, code, oldString, newString, content, id, name,
questions` and `toolMetadata` only `name, provider, sessionID, command, shellID,
status, background, count, matches, files, loaded, answers, diagnostics` — keys
outside those sets are dropped, so a card reading arbitrary args should use
`props.input` directly (as `OmpTool` does with `input().code`, `omp-tools.tsx:103-108`).

---

## 4. Worked example: a custom `ask_user` tool

### 4.1 The tool

Custom tools live in `~/.omp/agent/tools/*.ts` and are
`CustomToolFactory`s from `@oh-my-pi/pi-coding-agent` — the shape used by the
tool on this machine, `~/.omp/agent/tools/bg.ts` (mounted as the `xd://bg`
device):

```ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"

const factory: CustomToolFactory = pi => ({
  name: "ask_user",
  label: "Ask user",
  description: "Ask the user one or more questions and wait for the answers.",
  parameters: pi.zod.object({
    questions: pi.zod.array(pi.zod.object({ question: pi.zod.string() })),
  }),
  async execute(_id, params) {
    const answers /* string[][] */ = await ask(params.questions)
    return {
      content: [{ type: "text", text: answers.flat().join("\n") }],
      details: { answers },
    }
  },
})

export default factory
```

The two return fields are load-bearing: `content` becomes the durable
`session.tool.success.data.content` and therefore the card's `output`
(`src/omp/map.ts:481-517`, `client/src/solid/data.ts:1093-1105`), while
`details` becomes `metadata` (`src/omp/map.ts:511-516`). The `bg.ts` tool's
`commands`/`timeout` args show the same convention.

### 4.2 What happens with no changes at all

1. OMP emits `tool_execution_start` with `toolName: "ask_user"`.
2. `rendererName("ask_user", { questions: [...] })`: not in `TOOL_NAME_MAP`, not
   an `xd://` write, not in `RENDERER_NAMES` or `OMP_TOOL_NAMES`, no `command`,
   `code`, `url`, `query`, `pattern` or `path` key — so it returns `"ask_user"`
   (`src/omp/map.ts:164-187`).
3. `session.tool.input.started` carries `name: "ask_user"`; the UI stores that on
   the tool part (`client/src/solid/data.ts:1059-1069`).
4. `ToolDisplay` asks `ToolRegistry.render("ask_user")` -> `undefined`, so it
   falls back to `GenericTool` (`tool-renderer.tsx:1371`).

`GenericTool` (`basic-tool.tsx:354-...`) renders title
`` i18n.t("ui.basicTool.called", { tool }) `` -> "Called `ask_user`"
(`opencode/packages/ui/src/i18n/en.ts:277`), a subtitle taken from the first of
`description, query, url, path, pattern, name` present in the input
(`labelKeys`, `basic-tool.tsx:335`), up to three `key=value` args for the other
keys (`basic-tool.tsx:345-351`), and — because `hasContent={!!props.output}`
(`basic-tool.tsx:367`) — the tool's output as markdown too. Works, but it reads
as one undifferentiated blob, gives no icon or action, and is titled with the
raw snake_case name (the group header does the same via
`ompToolTitle` -> `undefined`, `tool-renderer.tsx:313`).

### 4.3 The two edits that give it a real card

**`src/omp/map.ts:104`** — pin the name so no future `path`/`query` argument can
hijack it to `read`/`websearch`:

```ts
const OMP_TOOL_NAMES = new Set([
  ...,
  "ask_user",
])
```

**`opencode/packages/session-ui/src/tools/omp-tools.tsx:40`** — register it
(and add the dictionary key). `answers` is already in the metadata whitelist, so
a full question-style card only needs the name mapped:

```ts
const specs: Record<string, OmpToolSpec> = {
  ...,
  ask_user: { icon: "bubble-5", title: "ui.tool.askUser" },
}
```

```ts
// opencode/packages/ui/src/i18n/en.ts, next to "ui.tool.ask" (:269)
"ui.tool.askUser": "Ask user",
```

For answer-aware rendering, register a hand-written card instead
(`tool-renderer.tsx`, before `registerOmpTools(ToolRegistry)`) — same signature
as §3.4, reading `props.input.questions` and `props.metadata.answers`:

```tsx
ToolRegistry.register({
  name: "ask_user",
  render(props) {
    const i18n = useI18n()
    const items = createMemo(() => questions(toolInput(props.input)))
    const answers = createMemo(() =>
      (toolMetadata(props.metadata).answers ?? []).flatMap((answer) => Option.toArray(decodeAnswer(answer))),
    )
    const completed = createMemo(() => answers().length > 0)

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{ title: i18n.t("ui.tool.askUser"), subtitle: `${items().length}` }}
      >
        {/* same body as the question card, tool-renderer.tsx:2679-2694 */}
      </BasicTool>
    )
  },
})
```

### 4.4 Custom-tool gotchas

* The card is keyed on the **name OMP reports**, not the file name. A factory
  may set any `name`; a name that appears in neither map is rendered by the
  fallback above.
* If the tool's args happen to include `path`, the fallback renders it as a file
  read/write card, and `ToolDisplay`'s error subtitle logic
  (`toolErrorSubtitle`, `tool-renderer.tsx:1430-1464`) will also treat it like a
  file tool. Pinning the name in `OMP_TOOL_NAMES` is the fix.
* A tool that dispatches an **xdev device** (`write xd://<device>`) never renders
  under its own name; `map.ts:142-149` renames it to the device, and the card
  must be registered under the device name (that is how `bg`, `debug` etc. work).
* A tool that spawns a subagent should reuse the subagent link path:
  `EventTranslator.linkSubagentTool` (`src/omp/map.ts:271-281`) emits
  `session.tool.progress` with `metadata.sessionID`, which the `subagent` card
  reads to open the child session (`tool-renderer.tsx:1928-...`, and
  `toolMetadata(...).sessionID` at `tool-renderer.tsx:1354-1356`). `map.ts`
  aliases OMP's `task` label and OpenCode's `description`
  (`session-timeline-row.tsx:45` imports `taskAgentName`).
* Nothing in the OpenCode engine/schema needs changing: tool names are free-form
  (`SessionMessageAssistantTool.name`, `opencode/packages/schema/src/session-event.ts:512-524`).

---

## 5. Verifying locally

All commands are the real scripts from the repo's `package.json` files.

**Translator (name normalization, shape fallback, arg translation)** — from the
openPI repo root:

```sh
bun run test            # openPI package.json: "test": "node --test test/"
```

`test/map.test.ts:192` covers the shape fallback and edit normalization; add your
new name there alongside `run_thing`/`xd://bg`.

**Render the card in isolation** — the stories server
(`opencode/packages/stories/package.json`: `"dev": "vite --port 6006"`):

```sh
bun run --cwd opencode/packages/stories dev
```

Then open `http://127.0.0.1:6006/?id=<story-id>`; `?args=key:value;...` and
`?globals=theme:dark` mirror Storybook's iframe query
(`opencode/packages/stories/src/frame.tsx:23`). Story ids are built by the story
index plugin from the meta's `id` (else `title`) plus the export name, both
sanitized to kebab-case (`opencode/packages/stories/src/index-plugin.ts:24-30`
and `sanitize`, `:65-70`). Example from the repo: the meta
`{ id: "current-tool-group" }` in
`opencode/packages/session-ui/src/tools/tool-group.stories.tsx:10-13` with
`export const MixedTools` yields `current-tool-group--mixed-tools`, which is the
id used by `component-tests/read-image.spec.ts:13`. Add a story for your card
next to the existing tool stories (`tool-group.stories.tsx`,
`read-group.stories.tsx`, `subagent-row-variants.stories.tsx`), building parts
with `storyTool(id, name, status, input, { output, metadata })`
(`opencode/packages/session-ui/src/storybook/current-session-scenarios.ts:5-44`).

**Component tests** — fixtures plus Playwright specs in
`opencode/packages/session-ui/component-tests/` (e.g. `read-image.fixture.tsx` /
`read-image.spec.ts`); the config boots the stories server itself
(`opencode/packages/session-ui/playwright.components.config.ts` ->
`opencode/packages/stories/playwright/config.ts:20-30`):

```sh
bun run --cwd opencode/packages/session-ui test:components
# or interactively:
bun run --cwd opencode/packages/session-ui test:components:ui
```

`bun run --cwd opencode/packages/session-ui test` (`"test": "bun test src"`) only
runs the pure unit tests in `src` (e.g. `tools/ansi.test.ts`,
`tools/shell-output.test.ts`) — it does not render cards.

**In the real app** — the components lab lists every story and lets you tweak
args; it is served by the dev server and mounted at `/components`:

```sh
bun run --cwd opencode/packages/app dev
```

The route is dev/beta-only (`opencode/packages/app/src/shell/routes/routes.tsx:74`),
and the lab reads the same story files (`src/components-lab/catalog.ts`).

**End-to-end through the bridge** — from the openPI repo root:

```sh
bun run ui:install      # "bun install --cwd opencode"
bun run ui:build        # "bun run --cwd opencode/packages/app build"
bun run start           # "node src/index.ts"
```

`bun run dev` runs the same entry point with `node --watch`
(openPI `package.json`). Then drive a session that calls the tool and watch the
SSE stream (`GET /api/event`, Basic auth) for the `session.tool.input.started`
name — that string is exactly what `ToolRegistry.render` will be asked for.
Set `OPENPI_DEBUG=1` to log every engine event and the envelopes it produced
(`src/core/manager.ts:419`).

# openPI architecture

openPI runs the **OpenCode v2 web UI** on top of the **Oh My Pi (OMP)** agent
engine. OpenCode's own engine (`packages/core` + `packages/server`) is replaced.
The UI is kept as-is, so the thing that must keep working is the OpenCode v2 HTTP
API that `packages/app` talks to.

Acceptance surface: `opencode web --hostname 0.0.0.0 --port 4096` is the command
people already use. The mobile client (and a plain browser) point at
`http://<host>:4096`. openPI must serve that same UI and API on port 4096, Basic
auth included, with OMP doing the work.

## Components

```
Browser / mobile client
        | HTTP + SSE (Basic auth), port 4096
openPI server (Node, this repo)
   |-- serves the vendored OpenCode v2 web app        opencode/ (fork) + src/server/app.ts
   |-- OpenCode v2 HTTP API subset it owns              src/server/routes.ts
   |     events  GET /api/event (SSE)                   src/core/feed.ts
   |     session CRUD + prompt/message/interrupt/model  src/core/manager.ts
   |-- proxies everything else to the private server    src/server/proxy.ts
   |
   | stdio (OMP RPC, JSONL, protocol v2)                src/omp/client.ts
omp --mode rpc-ui --session-dir <dir-per-session>        (child process)
```

Why proxy? Non-engine endpoints (fs, vcs, worktree, pty, shell, mcp,
integration, plugin, websearch, debug) are not part of "the engine". A private
OpenCode server implements them correctly and ships the web app. openPI runs the
vendored fork in `opencode/` for that server, so the UI is ours to change, and
falls back to an `opencode` binary when the fork is not built. The bridge owns
the engine-facing endpoints and forwards the rest.

## Wire contract (captured from opencode v2.2.5)

### SSE frame, `GET /api/event`

One JSON document per `data:` line. Heartbeat is a comment line.

```
data: {"id":"evt_...","created":1794505530326,"type":"session.created","location":{"directory":"/tmp/x"},"data":{...},"durable":{"aggregateID":"ses_...","seq":0,"version":1}}

: heartbeat
```

Envelope fields:

- `id` `evt_<base36>`
- `created` epoch ms
- `type` one of the session event types below
- `location` `{ directory }` (present on session-scoped events)
- `data` type-specific payload; `sessionID` is always present
- `durable` only on durable events: `{ aggregateID, seq, version }`

### Response wrappers

- Raw object: `/api/info`, `/api/location`
- `{ "location": { "directory": ... }, "data": ... }`: agent/model/provider/
  command/skill/reference/fs list
- `{ "data": ..., "cursor": { "previous"?, "next"? } }`: `/api/session` list,
  `/api/session/:id/message`
- `{ "data": ... }`: POST responses (session create, prompt)
- Errors: `{ "_tag": "UnauthorizedError", "message": "..." }` with the matching
  HTTP status.

### Events the UI consumes (from `packages/schema/src/session-event.ts`)

`session.created`, `session.agent.selected`, `session.model.selected`,
`session.renamed`, `session.deleted`, `session.moved`, `session.metadata.updated`,
`session.permissions`, `session.viewed`, `session.execution.started|succeeded|failed|interrupted`,
`session.step.started|streamed|ended|failed`,
`session.text.started|delta|ended`,
`session.reasoning.started|delta|ended`,
`session.tool.input.started|delta|ended`, `session.tool.called|progress|success|failed`,
`session.retry.scheduled`, `session.compaction.started|delta|ended|failed`,
`session.shell.started|ended`, `session.inbox.enqueued|delivered|cancelled|delivery.changed`,
`session.synthetic`, `session.usage.updated`, `session.skill.activated`.

Durable event version numbers: most `1`, `session.deleted` and `session.forked`
and `session.tool.success|failed` are `2`.

### Messages (`packages/schema/src/session-message.ts`)

`GET /api/session/:id/message` returns `data: Message[]`. Message variants:
`user`, `assistant`, `idle`, `model-switched`, `agent-switched`, `system`,
`synthetic`, `skill`, `shell`, `compaction`.

User message:

```json
{ "id":"msg_...", "type":"user", "time":{"created":0}, "text":"hi", "files":[], "agents":[], "skills":[] }
```

Prompt `files` arrive as `PromptInput.FileAttachment` (`{ uri, name? }`).
openPI resolves the `uri` (`data:` inline, `file:`, or a filesystem path)
into base64 bytes once, so the message's `files` become the decodable
`Prompt.FileAttachment` shape `{ data, mime, source }`. Image attachments are
forwarded to OMP on the prompt as `ImageContent[]`; non-image attachments are
appended to the model message as text. See src/core/attachments.ts.

Transcripts stored before attachments were materialized keep the raw
`PromptInput.FileAttachment` and crash the UI (`mime` is absent). The manager
repairs those user messages when a session is first loaded and saves the
upgraded record; an attachment it can no longer read is dropped.

Assistant message:

```json
{ "id":"msg_...", "type":"assistant", "time":{"created":0,"completed":0},
  "agent":"build", "model":{"providerID":"anthropic","modelID":"claude-..."},
  "content":[
    {"type":"reasoning","text":"...","time":{"created":0,"completed":0}},
    {"type":"text","text":"..."},
    {"type":"tool","id":"call_1","name":"read","executed":true,
     "state":{"status":"completed","input":{},"content":[{"type":"text","text":"..."}],
              "metadata":{}},
     "time":{"created":0,"ran":0,"completed":0}}
  ],
  "cost":0, "tokens":{...}, "finish":"stop" }
```

Idle message marks the end of a turn:

```json
{ "id":"msg_...", "type":"idle", "time":{"created":0}, "outcome":"succeeded" }
```

`Session.Info` (from `GET /api/session`, `POST /api/session`):

```json
{ "id":"ses_...", "projectID":"...", "agent":"build",
  "model":{"providerID":"...","modelID":"..."},
  "cost":0, "tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},
  "time":{"created":0,"updated":0}, "title":"...",
  "location":{"directory":"/abs/path"} }
```

### Prompt request

`POST /api/session/:id/prompt`

```json
{ "text":"...", "files":[], "agents":[], "skills":[], "delivery":"queue"|"steer" }
```

Returns `{ "data": <Session.Inbox.User> }`.

## OMP RPC contract

`omp --mode rpc [--session-dir DIR]` speaks newline-delimited JSON on stdio.
Sessions are spawned with `--mode rpc-ui` (same protocol, plus the tool UI
context the question dock needs); the catalog-only client stays on plain `rpc`.

Startup: server writes `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],...}`.
Client should send `{"id":"...","type":"negotiate_protocol","protocolVersion":2}`.

Commands (all take optional `id`; responses echo it):
`prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session`,
`open_session`, `get_state`, `set_model`, `get_available_models`,
`set_thinking_level`, `compact`, `get_messages`, `get_messages_page`,
`get_session_stats`, `set_session_name`, `bash`, `fork`, `switch_session`.

Outbound frame kinds: `ready`, `response` (`{type,command,success,data?,error?}`),
agent events, `extension_ui_request`, `available_commands_update`,
`prompt_result`, `session_settled`, `rpc_chunk` (protocol v2 oversized frames).

Agent events (`packages/agent/src/types.ts`):

- `agent_start`, `agent_end` (`messages`, `yielded`)
- `turn_start`, `turn_end`
- `message_start` / `message_update` / `message_end` (each carries `message`;
  `message_update` also carries `assistantMessageEvent`)
- `tool_execution_start` `{toolCallId,toolName,args}`
- `tool_execution_update` `{toolCallId,toolName,args,partialResult}`
- `tool_stream_update`, `tool_execution_end` `{toolCallId,toolName,result,isError}`

`assistantMessageEvent` streaming variants (`packages/ai/src/types.ts`):
`start`, `text_start|text_delta|text_end`, `thinking_start|thinking_delta|thinking_end`,
`toolcall_start|toolcall_delta|toolcall_end`, `image_end`, `done`, `error`.

## User input: OMP dialogs -> OpenCode forms

OMP asks its host for input over the RPC stream (`extension_ui_request`). The
OpenCode UI has no dialog surface of its own, so openPI turns every dialog into
a **form**; the vendored UI renders a pending form as a composer dock, and a
form whose `metadata.kind` is `"question"` opens the question dock, which asks
the fields in order and offers its own free-text answer.

Engine side (`src/core/manager.ts`):

- Sessions spawn `omp --mode rpc-ui`; plain `rpc` never emits tool UI, so the
  `ask` tool is not even loaded. `rpc-ui` also pins `PI_NO_PTY=1`, which turns
  off OMP's interactive PTY bash path.
- After `ready` the manager sends `set_ask_dialog { enabled: true }`, which opts
  this host in to the structured `ask` request (one frame carrying every
  question of an extension `ui.askDialog` call). OMP's own `ask` tool does not
  use it: over RPC it always walks its HTML form field by field with `select`
  and `editor`, which is why the per-dialog methods below are the ones that
  actually carry question forms today.
- Dialogs become forms as described in `src/omp/ui-forms.ts`: `ask` -> one field
  per question (`q0`, `q1`, ... in request order, `multiselect` when the question
  allows several answers), `select`/`editor`/`input`/`confirm` -> one field. The
  question dock draws its text from the *field*, so `select` puts the request's
  `title` in `description` and the other methods put it in `title`.
  A recommended option is hoisted to the front and labelled
  `"<label> (Recommended)"`; its option `value` stays the untouched label,
  because OMP matches answers against the labels it sent.
- OMP's `select` rows are passed through verbatim, sentinels included: its
  `"Other (type your own)"` row is what makes the engine open its own free-text
  `input` dialog, and its `"✔ Done selecting"` row is the only way to end a
  checkbox group. Several answers are a loop — the engine re-asks under a
  `"(N selected) "` title after every pick — so one dock submission answers one
  step of it.
- The answer comes back keyed by field key and is encoded into the request's own
  response shape (a label that is not one of the options becomes `customInput`).
  `confirm` answers `{ confirmed }`; everything else `{ value }` or
  `{ cancelled, timedOut? }`. A request that carries nothing renderable is
  answered `cancelled` instead of being left unanswered, which would stall the
  turn; presentation methods (`notify`, `setStatus`, ...) need no answer.
- `cancel` requests close the dock for the dialog OMP gave up on (its timeout or
  an abort). Aborting, stopping a session, or losing the engine cancels every
  form that session is waiting on.

HTTP surface openPI owns (`src/server/routes.ts`, events in `src/core/forms.ts`):

- `GET /api/form` (location-wrapped), `GET|POST /api/session/:id/form`,
  `GET /api/session/:id/form/:formID`,
  `POST /api/session/:id/form/:formID/reply` `{ answer }`,
  `DELETE /api/session/:id/form/:formID?message=`.
- SSE: `form.created` `{ form }`, `form.replied` `{ id, sessionID, answer }`,
  `form.cancelled` `{ id, sessionID }`. Forms are **ephemeral**: no `durable`
  field, nothing in the transcript, nothing across a restart.
- A settled form is gone from the registry, so a second reply answers 404 — what
  the UI reads as "already answered".

## Mapping OMP -> OpenCode

| OMP | OpenCode |
| --- | --- |
| agent_start | `session.execution.started` |
| message_start (assistant) | new assistant message + `session.step.started` |
| assistantMessageEvent text_start/delta/end | `session.text.started/delta/ended` |
| assistantMessageEvent thinking_* | `session.reasoning.started/delta/ended` |
| assistantMessageEvent toolcall_start/delta/end | `session.tool.input.started/delta/ended` |
| message_end (assistant) | `session.step.ended` + finalize message |
| tool_execution_start | `session.tool.called` |
| tool_execution_update | `session.tool.progress` |
| tool_execution_end | `session.tool.success` / `session.tool.failed` |
| agent_end (yielded) | `session.execution.succeeded` + idle message |
| prompt_result (terminal) | `session.execution.succeeded` / `failed` / `interrupted` |
| abort command | `session.execution.interrupted` |
| notice level=error | `session.execution.failed` |
| session_info_update / setTitle | `session.renamed` |

`prompt_result` is the authoritative end of a turn. A yielded `agent_end`
already ends it, but a provider/model error arrives only in `prompt_result`, so
the translator tracks the assistant message's stop reason and lets that frame
emit `session.execution.failed` instead of leaving the UI on "working".

OMP tool names are normalized to the names the OpenCode UI renders specially:
`bash` -> `shell`, `task` -> `subagent`, `eval` -> `execute`, `web_search` ->
`websearch`. Every other known OMP tool is forwarded unchanged, and the vendored
UI registers a card for it (see `opencode/packages/session-ui/src/tools`). A
tool neither side knows is mapped to a renderer by the shape of its input
(`command` -> shell, `code` -> execute, `url` -> webfetch, `query` -> websearch,
`pattern` -> grep, `path` -> read/write/edit) and keeps the tool's output, which
the generic card now shows instead of hiding. OMP's `edit` args are also
translated from `old_string`/`new_string` to the `oldString`/`newString` the
renderer reads. A running subagent tool is linked to its child session by
emitting `session.tool.progress` with `metadata.sessionID`, which is what the UI
reads to open the subagent; the subagent card reads OMP's `task` label as well
as OpenCode's `description`. Unknown session sub-resources answer with safe
defaults so the UI never 404s.

OMP forces `PI_NO_TITLE=1` in RPC mode, so it never names a session. openPI
generates the title itself on the first prompt with one short out-of-band
`omp -p` call and publishes `session.renamed`; a `session_info_update` or
`setTitle` frame is honored if the engine ever sends one.

## Milestones

1. **Foundation (this):** repo, contract docs, OMP RPC client with protocol v2
   framing + tests, event translator + tests, bridge server (info, location,
   event SSE, session CRUD, prompt, message, interrupt, model list) with tests,
   proxy fallback, runnable against the real `opencode` upstream.
2. **UI parity:** model/provider/agent/config endpoints served from OMP, skills,
   commands, permissions, forms, revert/fork, compaction, session titles.
3. **Self-contained (done):** the OpenCode v2 source is vendored under
   `opencode/` and its web app is built here, so the upstream opencode binary is
   optional. Editing tool cards means editing the fork.
4. **Hardening:** multi-session OMP supervision, reconnect, auth parity, OMP
   session persistence/restore, thinking level, subagents, review.

## File layout

```
src/omp/frames.ts     JSONL framing + protocol v2 chunk reassembly
src/omp/client.ts     spawn + command/response correlation + event stream
src/omp/map.ts        EventTranslator: OMP event -> OpenCode event envelope
src/core/feed.ts      global SSE feed, one encoded frame, per-connection queues
src/core/store.ts     sessions + messages (node:sqlite)
src/core/ids.ts       evt_/msg_/ses_ id generation
src/core/attachments.ts prompt attachment URIs -> UI file shape + OMP images
src/core/manager.ts   session <-> OMP process lifecycle and projection
src/server/routes.ts  HTTP routes openPI owns
src/server/proxy.ts   static + API passthrough to the private OpenCode server
src/server/upstream.ts starts the private server (vendored fork or opencode binary)
src/server/app.ts     request dispatch
src/index.ts          entry point / config
opencode/             the vendored OpenCode v2.2.5 fork (web app + server)
opencode/packages/session-ui/src/tools  the tool cards, OMP ones included
test/                 node --test
```

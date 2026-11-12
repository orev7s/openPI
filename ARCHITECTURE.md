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
   |-- serves OpenCode v2 web app (static)              src/server/app.ts
   |-- OpenCode v2 HTTP API subset it owns              src/server/routes.ts
   |     events  GET /api/event (SSE)                   src/core/feed.ts
   |     session CRUD + prompt/message/interrupt/model  src/core/manager.ts
   |-- proxies everything else to an upstream server    src/server/proxy.ts
   |
   | stdio (OMP RPC, JSONL, protocol v2)                src/omp/client.ts
omp --mode rpc --session-dir <dir-per-session>           (child process)
```

Why proxy? Non-engine endpoints (fs, vcs, worktree, pty, shell, mcp,
integration, plugin, websearch, debug) are not part of "the engine". An upstream
`opencode serve` already implements them correctly and also ships the built web
app. The bridge owns the engine-facing endpoints and forwards the rest.

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
| abort command | `session.execution.interrupted` |
| notice level=error | `session.execution.failed` |

## Milestones

1. **Foundation (this):** repo, contract docs, OMP RPC client with protocol v2
   framing + tests, event translator + tests, bridge server (info, location,
   event SSE, session CRUD, prompt, message, interrupt, model list) with tests,
   proxy fallback, runnable against the real `opencode` upstream.
2. **UI parity:** model/provider/agent/config endpoints served from OMP, skills,
   commands, permissions, forms, revert/fork, compaction, session titles.
3. **Self-contained:** build/serve `packages/app` from this repo so the upstream
   opencode binary is no longer required.
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
src/core/manager.ts   session <-> OMP process lifecycle and projection
src/server/routes.ts  HTTP routes openPI owns
src/server/proxy.ts   static + API passthrough to upstream
src/server/app.ts     request dispatch
src/index.ts          entry point / config
test/                 node --test
```

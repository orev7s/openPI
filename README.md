# openPI

openPI runs the [OpenCode](https://github.com/sst/opencode) web UI on top of
[Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) as the agent engine.

You get the polished OpenCode client (browser or phone) and the OpenCode v2 HTTP
API. The thinking, the tools and the model calls all happen in `omp`.

## Why would you want this

OpenCode and Oh My Pi are both good at different things.

OpenCode has a clean web and mobile interface, session history, a model picker
and a lot of small UI touches. Its agent engine is its own thing.

Oh My Pi is an engine you can reshape. Its selling point is that you can ask the
agent to build a new tool or a new harness piece, and it will. Tools are not
frozen into the binary.

openPI lets you keep the OpenCode UI you already like and point it at the OMP
engine. That means a custom tool your agent just wrote shows up in the normal
tool timeline with its command and its output, subagents show up as child
sessions you can open, and sessions name themselves from the first thing you
ask, the same way OpenCode names them.

## Requirements

- Node 24 or newer (the code uses `node:sqlite` and runs TypeScript directly).
- `omp` on your `PATH`. This is the engine that does the work.
- Bun, to run the vendored OpenCode fork in `opencode/`. openPI serves that
  fork's web app and its non-agent endpoints (filesystem, git, terminals, MCP).
  It never routes agent work through it. If the fork is not built, openPI falls
  back to an `opencode` binary on your `PATH`.

## Quick start

```sh
# clone
git clone https://github.com/orev7s/openPI.git
cd openPI

# build the vendored OpenCode fork (the web app openPI serves)
bun run ui:install
bun run ui:build

# auth for the web UI. If unset, openPI runs with auth disabled.
export OPENPI_PASSWORD=choose-something

node src/index.ts
```

Then open `http://localhost:4096` (or point the OpenCode mobile client at
`http://<host>:4096`). Basic auth uses the password above with any username.

The defaults already match the common case: serve on `0.0.0.0:4096`, run
sessions against the current directory, and store data in `~/.openpi`.

## Configuration

All configuration is environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENPI_PORT` | `4096` | Port to listen on |
| `OPENPI_HOST` | `0.0.0.0` | Host to bind |
| `OPENPI_DIRECTORY` | current directory | The project sessions run against |
| `OPENPI_DATA_DIR` | `~/.openpi` | Session database and per-session OMP dirs |
| `OPENPI_PASSWORD` | falls back to `OPENCODE_PASSWORD`, then `OPENCODE_SERVER_PASSWORD` | Basic auth password. If none is set, auth is off |
| `OPENPI_UPSTREAM` | none | Point at an already running `opencode serve` for the UI and proxied endpoints |
| `OPENPI_UPSTREAM_DISABLE` | unset | Set to `1` to run without an upstream (API only, no web UI) |
| `OPENPI_OMP_COMMAND` | `omp` | The OMP executable |
| `OPENPI_OMP_ARGS` | none | Extra arguments passed after `omp --mode rpc` |

## How it works

```
browser / mobile client
      |  HTTP + SSE + Basic auth
openPI server (Node)
      |-- serves the OpenCode web app          the vendored fork in `opencode/`
      |-- owns the agent-facing API            GET /api/event (SSE),
      |                                        /api/session*, /api/model, ...
      |-- proxies everything else              fs, git, pty, shell, mcp, ...
      |
      |  stdio, newline-delimited JSON (OMP RPC protocol v2)
omp --mode rpc --session-dir <per-session dir>
```

openPI starts a private OpenCode server for two narrow jobs: serving the built
web app, and answering the endpoints that are not part of the agent engine.
It prefers the vendored fork in `opencode/`, so the UI is ours to change, and it
falls back to an `opencode` binary on your `PATH` when that fork is not built.
Every agent turn runs in its own `omp` process.

The interesting part is the translation layer. OMP speaks its own event
protocol. The UI speaks the OpenCode v2 session event protocol. openPI maps one
to the other, including tool calls, streaming text and reasoning, subagents and
turn outcomes.

If you want the exact wire format, the event list and the full OMP to OpenCode
mapping, read [ARCHITECTURE.md](ARCHITECTURE.md). It is the deep version of this
section.

## Tool names and the UI

The web UI renders tools by name through a registry: each name maps to a card
component. The vendored fork in `opencode/` extends that registry with the tools
OMP ships, so they render as their own cards instead of a generic blob:

- `todo` shows the checklist it wrote, with per-item status.
- `wait`, `find`, `lsp`, `ast_grep`, `ast_edit`, `github`, `checkpoint`,
  `rewind`, `context_notes`, `new_context`, `security_scan`, `debug`, `ida`,
  the memory tools, `manage_skill`, `browser`, `computer`, `image_gen`, `ask`
  and `report_tool_issue` each get a titled card with their arguments and their
  result.
- Anything still unknown falls back to the generic card, which now shows the
  tool's output instead of hiding it.

The fork also understands OMP's raw names for tools that already have a card,
so `bash` renders as the shell card, `task` as the subagent card, `eval` as the
execute card and `web_search` as the web search card even before openPI's rename.

openPI still renames those four on the way through, and it forwards every other
known OMP tool unchanged. It only guesses a renderer from the input shape for a
tool it has never seen, so a custom tool your agent just created still lands in
the transcript rather than being dropped. A tool that takes a `command` renders
as a shell card, one that takes `code` renders as an execute card, `url` becomes
a fetch, `query` becomes a search, and a `path` becomes a read, write or edit
depending on the rest of the arguments.

The fork adapts to OMP's subagent too. OMP's `task` input names its work `task`,
not `description`, so the subagent card reads both, and the child session OMP
spawns opens from the card the same way a native subagent does.

One small fix worth calling out: OMP sends edit arguments as `old_string` and
`new_string`, but the OpenCode editor reads `oldString` and `newString`. openPI
translates those too, otherwise every edit would render as an empty diff.

## Attachments

The composer sends an attachment as a `uri` (an inline `data:` URL, a `file:`
URL, or a path). openPI resolves it once into base64 bytes: the persisted user
message and the `session.inbox.enqueued` event carry the `{ data, mime, source }`
shape the UI decodes, and image attachments are passed to OMP on the prompt.
Anything else is appended to the model prompt as text, so a picture, a PDF or a
source file all reach the engine instead of being silently dropped.

Sessions written before this existed stored the raw `{ uri }` and would crash
the UI on open. openPI repairs those transcripts the first time they are loaded
and persists the upgraded messages, so an old session recovers instead of
having to be recreated. An attachment that can no longer be read (a directory
mention, a deleted file) is dropped rather than left in the broken shape.

## Session titles

OMP disables its own title generation when it runs in RPC mode, so sessions would
otherwise stay unnamed. On the first prompt, openPI makes one short out-of-band
call to name the session, then publishes the rename the same way OpenCode does.
If the first message has nothing to name (a greeting, say), it tries again on a
later prompt. This costs one small model call per session.

## Limitations

- openPI is early. The agent-facing endpoints are covered, but not every
  peripheral endpoint is specially handled. Anything not owned by openPI is
  proxied straight to the private `opencode serve`.
- When an `omp` process exits, the next prompt starts a fresh one. The
  transcript is kept, but the engine does not yet resume its side of the
  conversation automatically.
- Auth is a single shared Basic auth password, matching the upstream behaviour.
- The web app ships as the vendored fork in `opencode/`, so that tree has to be
  installed and built before the UI is served. `bun run ui:install` and
  `bun run ui:build` do that.

## Development

```sh
# run with a watch loop
node --watch src/index.ts

# run the tests
node --test test/

# rebuild the vendored web app after editing opencode/packages/app or
# opencode/packages/session-ui
bun run ui:build
```

The vendored fork's own package scripts still work from `opencode/`, for example
`bun run --cwd opencode/packages/session-ui typecheck`. Its tool cards live in
`opencode/packages/session-ui/src/tools`.

The tests are plain `node:test`. The integration tests drive the server against
a fake OMP over the real RPC framing, so they cover the SSE stream, the
persisted transcript, a failed turn, a custom tool and session titling without
needing a model.

Extra logging is available with `OPENPI_DEBUG=1`.

## License

MIT. See [LICENSE](LICENSE).

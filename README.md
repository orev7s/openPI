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
- `opencode` on your `PATH`. openPI uses its built web app and its non-agent
  endpoints (filesystem, git, terminals, MCP). It never routes agent work
  through it.

## Quick start

```sh
# clone
git clone https://github.com/orev7s/openPI.git
cd openPI

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
      |-- serves the OpenCode web app          proxied to a private `opencode serve`
      |-- owns the agent-facing API            GET /api/event (SSE),
      |                                        /api/session*, /api/model, ...
      |-- proxies everything else              fs, git, pty, shell, mcp, ...
      |
      |  stdio, newline-delimited JSON (OMP RPC protocol v2)
omp --mode rpc --session-dir <per-session dir>
```

openPI starts a private `opencode serve` for two narrow jobs: serving the built
web app, and answering the endpoints that are not part of the agent engine.
Every agent turn runs in its own `omp` process.

The interesting part is the translation layer. OMP speaks its own event
protocol. The UI speaks the OpenCode v2 session event protocol. openPI maps one
to the other, including tool calls, streaming text and reasoning, subagents and
turn outcomes.

If you want the exact wire format, the event list and the full OMP to OpenCode
mapping, read [ARCHITECTURE.md](ARCHITECTURE.md). It is the deep version of this
section.

## Tool names and the UI

The OpenCode UI renders tools by name. It has a special card for `shell`,
`execute`, `read`, `edit`, `write`, `grep`, `glob`, `subagent` and a few others.
Any other name falls back to a generic card that shows the tool name and its
input but hides the output.

OMP names some of the same tools differently, so openPI renames them on the way
through:

| OMP tool | Shown as |
| --- | --- |
| `bash` | `shell` |
| `task` | `subagent` |
| `eval` | `execute` |
| `web_search` | `websearch` |

For a tool the UI has never heard of (including one your agent just created),
openPI picks the closest renderer from the shape of the tool's input. A tool
that takes a `command` renders as a shell card, one that takes `code` renders as
an execute card, `url` becomes a fetch, `query` becomes a search, and a `path`
becomes a read, write or edit depending on the rest of the arguments. If nothing
matches, it stays generic. Either way the call, its input and its result end up
in the transcript.

One small fix worth calling out: OMP sends edit arguments as `old_string` and
`new_string`, but the OpenCode editor reads `oldString` and `newString`. openPI
translates those too, otherwise every edit would render as an empty diff.

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
- The upstream `opencode` binary is still required for the web assets and the
  proxied endpoints. Bundling the app into this repo is future work.

## Development

```sh
# run with a watch loop
node --watch src/index.ts

# run the tests
node --test test/
```

The tests are plain `node:test`. The integration tests drive the server against
a fake OMP over the real RPC framing, so they cover the SSE stream, the
persisted transcript, a failed turn, a custom tool and session titling without
needing a model.

Extra logging is available with `OPENPI_DEBUG=1`.

## License

MIT. See [LICENSE](LICENSE).

# openPI

Run the **OpenCode v2 web UI** on top of the **Oh My Pi (OMP)** agent engine.

OpenCode's own agent engine (`packages/core` + `packages/server`) is replaced.
The UI is kept exactly as it ships, so the command people already use keeps
working:

```sh
opencode web --hostname 0.0.0.0 --port 4096
```

openPI serves that same web app and the OpenCode v2 HTTP API on port 4096, with
Basic auth, but the work is done by `omp`. Point a browser or the OpenCode mobile
client at `http://<host>:4096`.

## How it works

```
Browser / mobile client
        | HTTP + SSE + Basic auth, :4096
openPI server (Node)
   |-- serves the OpenCode v2 web app            proxy -> private opencode
   |-- owns the engine-facing API                GET /api/event (SSE),
   |                                             /api/session*, /api/model, ...
   |-- proxies the rest                          fs, vcs, pty, shell, mcp, ...
   |
   | stdio: OMP RPC (newline JSON, protocol v2)  src/omp/
omp --mode rpc --session-dir <per-session dir>
```

openPI starts a private `opencode serve` for two jobs only: serving the built web
UI assets, and answering the non-engine endpoints (filesystem, VCS, PTY, MCP,
and so on). Every agent turn runs in OMP. See `ARCHITECTURE.md` for the exact
wire contract and the OMP to OpenCode event mapping.

## Run

```sh
node src/index.ts
```

Configuration (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENPI_PORT` | `4096` | Listen port |
| `OPENPI_HOST` | `0.0.0.0` | Listen host |
| `OPENPI_DIRECTORY` | `cwd` | Project sessions run against |
| `OPENPI_DATA_DIR` | `~/.openpi` | Session store and OMP conversation dirs |
| `OPENPI_PASSWORD` | falls back to `OPENCODE_PASSWORD` | Basic auth password (`opencode`) |
| `OPENPI_UPSTREAM` | (spawn private `opencode serve`) | Use an existing server for UI + proxy |
| `OPENPI_UPSTREAM_DISABLE` | unset | Set `1` to run with no upstream |
| `OPENPI_OMP_COMMAND` | `omp` | OMP executable |
| `OPENPI_OMP_ARGS` | none | Extra args after `omp --mode rpc` |

## Status

Foundation is built and tested. Verified against the real engine and the real
UI:

- unit and integration tests: `node --test test/` (22 passing), including an
  end-to-end test that drives a prompt through a fake OMP and asserts the SSE
  stream and the persisted transcript;
- a real turn through the live `omp` engine: a prompt produced `pong`, streamed
  as `session.text.delta`, and the transcript persisted user, assistant and idle
  messages;
- the real OpenCode v2 web app is served on the listen port, `/api/model`
  reports OMP's 235-model catalog, and the non-engine endpoints proxy through
  to the private upstream.

What is implemented: OMP RPC transport with protocol v2 framing, the OMP to
OpenCode event translator, the SSE feed, the session store and manager, and the
engine-facing routes (`info`, `location`, `event`, `session*`, `model`,
`provider`, `agent`) with a proxy fallback for everything else. See
`ARCHITECTURE.md` for the milestone list. Next up: model/provider/agent served
from OMP config, skills, commands, permissions, fork/revert, compaction, and
browser verification of the UI.

## Tests

```sh
node --test test/
```

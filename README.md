# fastcar 🏎️

A multi-vendor agent harness built on the [Pi coding agent SDK](https://pi.dev)
(`@earendil-works/pi-coding-agent`): a **conductor** agent running on
InceptionLabs **Mercury** that routes work to subagents on **OpenRouter**, with
a Hermes-style dark web UI, Postgres-backed threads and memories, a
plan → approve → act workflow, blocking clarifying questions, Tavily web search,
and voice prompts via speech-to-text.

## Documentation site

The rendered documentation lives on GitHub Pages:

> **https://heyo-computer.github.io/fastcar/**

(Replace `heyo-computer` with the actual GitHub username/organization above
once GitHub Pages is enabled for the repository.)

The source Markdown for the docs lives in [`artifacts/docs/`](artifacts/docs/).
A GitHub Actions workflow
([`.github/workflows/render-artifacts.yml`](.github/workflows/render-artifacts.yml))
converts every `.md` file there to standalone HTML with pandoc and publishes
the result to the `gh-pages` branch on every push to `main`.

## Architecture

```
                     ┌──────────────────────────────────────────┐
  Browser (React) ⇄ WS/REST ⇄ Fastify server                    │
                     │                                          │
                     │  ThreadManager ── per-thread state machine│
                     │       │            idle / running /       │
                     │       │            awaiting_input /       │
                     │       │            awaiting_approval      │
                     │  Conductor session (Pi AgentSession)      │
                     │   model: inceptionlabs/mercury-2.5        │
                     │   tools: read bash edit write grep find ls│
                     │          run_subagent ask_user submit_plan│
                     │          memory_* web_search              │
                     │       │                                   │
                     │  SubagentManager (in-process Pi sessions) │
                     │   ├─ maxcoding  → openrouter/$MAXCODING_MODEL
                     │   └─ minimodel  → openrouter/$MINIMODEL_MODEL
                     └──────────────────────────────────────────┘
   Postgres: threads, events (UI history), memories (FTS)
   Pi JSONL sessions (.fastcar/sessions): agent-context source of truth
   OpenRouter /audio/transcriptions: voice → text (never via Pi)
```

**Model routing.** One shared Pi `ModelRuntime` serves every session. The
InceptionLabs provider is registered programmatically (OpenAI-compatible,
`$INCEPTION_API_KEY`); everything else rides OpenRouter (`$OPENROUTER_API_KEY`).
Subagents are plain in-process Pi `AgentSession`s with their own model, tools,
and system prompt — Pi deliberately ships no subagent primitive, so the
conductor's `run_subagent` tool creates them on demand (with per-kind
concurrency limits and abort cascade).

**Source-of-truth split.** Pi's JSONL session files are the *agent context*
truth (resumed across restarts); Postgres `events` is the *UI history* truth
(replayed on page load). Stream deltas go to the browser live over WS and are
never persisted; complete items are flushed to Postgres when each run ends.

## Deploying as a Firecracker microVM

`deploy/` contains a heyvm-built Firecracker rootfs (Dockerfile → ext4) and an
app-lb deployment spec for serverctl, with all configuration supplied via the
deployment JSON's `env_vars`. See [deploy/README.md](deploy/README.md):

```sh
./deploy/build-image.sh
$EDITOR deploy/fastcar.json      # fill REPLACE_ME_* keys + route host
serverctl apply -f deploy/fastcar.json
```

## Requirements

- Node ≥ 22.19
- Postgres (`DATABASE_URL`)
- API keys: `INCEPTION_API_KEY`, `OPENROUTER_API_KEY`, `TAVILY_API_KEY`
  (or none — see mock mode)

## Setup

```bash
npm install
cp .env.example .env       # fill in keys and DATABASE_URL
docker run -d --name fastcar-pg -p 5433:5432 \
  -e POSTGRES_USER=fastcar -e POSTGRES_PASSWORD=fastcar -e POSTGRES_DB=fastcar \
  postgres:16            # or point DATABASE_URL at your own Postgres
npm run migrate
npm run dev                # server on :3000 (serves web/dist if built)
npm run dev:web            # UI with HMR on :5173, proxying /api + /ws to :3000
```

The server reads `.env` from the repo root (falling back to `server/.env`, or
`FASTCAR_ENV_FILE` if set) — real environment variables always take precedence,
which is how the deployed VM supplies config with no `.env` present.

For the UI, either run `npm run dev:web` and open http://localhost:5173, or
build once for single-process serving — `npm run build`, then `npm run dev`
(or `npm start`) serves `web/dist` at http://localhost:3000.

### Mock mode (no API keys)

```bash
DATABASE_URL=... FASTCAR_MOCK=1 npm run dev
```

A built-in OpenAI-compatible mock drives the real Pi loop, real tools, and the
real UI with canned responses. Prompts containing **"ask"** trigger the
question flow, **"delegate"** the subagent flow; plan-mode threads produce a
mock plan for the approval flow. Mock transcription and Tavily responses are
included.

### Smoke tests

```bash
npm run smoke -- "hello, look around"     # CLI conductor session (mock)
npm run smoke:ws                          # full WS protocol suite against a running server
                                          # (FASTCAR_SMOKE_BARE_REPO=<path> also tests add-repo)
npm run smoke:git                         # git clone/branch/commit/push round-trip
```

Every script above also runs under `bun` (`bun dev`, `bun run build`, …). The
root scripts delegate with `cd <workspace> && npm run <script>` rather than
npm's `--workspace` flag, because bun rewrites `npm run` to `bun run` and then
ignores `--workspace` — which re-runs the root script of the same name and
recurses forever.

## Environment variables

| Var | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection | required |
| `INCEPTION_API_KEY` | Conductor model auth (Mercury) | required unless mock |
| `INCEPTION_MODEL` | InceptionLabs chat model id for the conductor | `mercury-2.5` |
| `INCEPTION_MAX_TOKENS` | `max_tokens` per conductor request — budget shared by Mercury's reasoning and its answer; raise it if high-effort turns end with `finish_reason: "length"` | `16384` |
| `CONDUCTOR_REASONING_EFFORT` | Mercury `reasoning_effort` at boot: `instant`, `medium`, `high`. The ⚙ settings modal overrides it at runtime (stored in `<data dir>/settings.json`) | `medium` |
| `OPENROUTER_API_KEY` | Subagents + transcription | required unless mock |
| `MAXCODING_MODEL` | OpenRouter slug for the heavy coding subagent | `anthropic/claude-sonnet-4.5` |
| `MINIMODEL_MODEL` | OpenRouter slug for the fast/cheap subagent | `google/gemini-2.5-flash-lite` |
| `TRANSCRIBE_MODEL` | OpenRouter STT model | `openai/whisper-large-v3` |
| `TAVILY_API_KEY` | Web search | optional |
| `FASTCAR_WORKDIR` | Directory the agents operate on | process cwd |
| `FASTCAR_REPOS_DIR` | Where cloned repositories live | `<workdir>/repos` |
| `FASTCAR_MCP_DIR` | Where installed MCP servers are cloned and built | `<data dir>/mcp` |
| `FASTCAR_SECRET` | Key for secrets stored at rest (SMTP password, MCP env/headers) | derived from the data dir path |
| `FASTCAR_GIT_NAME` / `FASTCAR_GIT_EMAIL` | Commit identity if the VM has no global git config | unset |
| `FASTCAR_DATA_DIR` | App state (Pi auth/models/sessions) — keep outside the workdir | `./.fastcar` |
| `FASTCAR_MOCK` | `1` = keyless mock mode | `0` |
| `FASTCAR_ENV_FILE` | Explicit env file to load instead of `.env` | unset |
| `PORT` | HTTP port | `3000` |
| `FASTCAR_PUBLIC_URL` | Externally reachable origin; prefix of the public artifact URLs the agent hands out | `http://localhost:$PORT` |

## Using it

- **Threads** live in the left sidebar (date-grouped); pick one on boot or
  start a new thread (or a new *plan* thread). Hover a thread for ✎ (rename —
  double-clicking the title works too, and `/rename <title>` renames the open
  thread) and × (delete, after a confirm). Deleting is a hard delete: the row,
  its history (events cascade), and its Pi session file all go, a run in flight
  is aborted, and the sidebar falls through to the next thread. A renamed thread
  keeps its name — auto-titling only ever fills in an untitled one.
- **Tasks** are a chat message or an attached/dropped `.md` file (sent as the
  task specification). The 🎙️ button records a voice prompt and drops the
  transcript into the composer.
- **Slash commands**: type `/` at the start of a message for the command menu
  (↑↓ to move, ⏎/⇥ to pick, esc to dismiss). Commands never reach the model —
  they render into the thread as app output: `/help`, `/context` (context
  window, tokens, cost), `/compact [focus]`, `/repos`, `/purge [repo]`, `/mcp`,
  `/memories [query]`, `/agents`, `/tools`, `/rename <title>`, `/plan`, `/act`,
  `/new [plan]`. The registry in
  `server/src/threads/commands.ts` is the single source of truth: the menu is
  served from it over `GET /api/commands`, so it can never offer something the
  server cannot run. Server commands need an idle thread.
- **@ mentions**: type `@` anywhere for subagents, registered repositories, and
  the files and directories inside them (fuzzy-matched, backed by
  `GET /api/mentions`; the index comes from `git ls-files` and is cached).
  The transcript keeps what you typed — the conductor additionally receives the
  resolved absolute paths, and reads the files itself rather than having them
  inlined.
- **Planning mode**: the agent explores read-only (mutating tools are blocked
  per-call), may ask questions, then submits a plan. Approve to execute
  (thread flips to act mode); request changes to get a revision. Read-only
  subagents are allowed here and can run in parallel: **minimodel** for
  exploration, and **maxcoding** with `mode: "plan"` to write the plan itself
  for complex tasks — it returns a plan plus a `## Questions for the user`
  section, which the conductor relays through `ask_user` before submitting.
  Implementing subagents stay blocked until the plan is approved.
- **Questions**: when the agent calls `ask_user`, the thread pauses until you
  answer in the question card.
- **Subagents** appear nested inside the `run_subagent` tool card with live
  activity; the conductor receives their final reports. The conductor is told to
  delegate by default: anything beyond a one-line code change goes to
  **maxcoding**, unfamiliar-code exploration goes to **minimodel**, and
  independent tasks go out in parallel. Complex tasks are planned first: a
  `mode: "plan"` maxcoding run (read-only, its own concurrency pool) explores
  and writes the plan and the questions only the user can answer; an
  implementing run may likewise stop *before changing anything* to return
  `## Questions for the user`. The conductor asks them via `ask_user` and
  re-dispatches with the answers.
- **Verification** is enforced, not merely requested. maxcoding owns its VM and
  installs whatever a task needs, then runs the project's tests/build/typecheck
  and reports a `## Verification` section with the commands it ran. If it
  changed something (`edit`/`write`/`bash`) and reported no such section, the
  harness sends it back for exactly one follow-up turn to run the checks before
  its report reaches the conductor (`server/src/pi/subagents.ts`).
- **Repositories**: the sidebar's Repositories panel lists every repo
  registered in the VM with live branch/dirty/ahead-behind status and the age of
  its last commit. "+" asks the agent to `git_clone` a URL — the clone runs in a
  visible thread. Agents get `git_clone` / `git_pull` / `git_checkout` /
  `git_commit` / `git_push` / `git_status` / `git_purge` / `git_list_repos`;
  auth uses whatever the VM has (ssh keys, credential helper, or a token
  embedded in an https URL — prompts are disabled so bad auth fails fast instead
  of hanging).
- **MCP servers**: the agent can install a [Model Context Protocol](https://modelcontextprotocol.io)
  server from a GitHub URL — e.g. `https://github.com/Heyo-Computer/heyo-public/tree/main/mcp`
  (branch and subdirectory are read from the URL), any git URL, or a remote
  http endpoint — and call its tools. Tools: `mcp_install` (clone, `npm install`,
  `npm run build`, entry point from `package.json`; pass `command`/`args` for
  non-Node servers and `env` for the configuration its README asks for),
  `mcp_list_servers`, `mcp_list_tools` (argument schemas), `mcp_call`,
  `mcp_remove`. Servers run over stdio on demand, restart if they die, and are
  registered in Postgres so they survive restarts; env vars and headers are
  encrypted at rest (`FASTCAR_SECRET`). The sidebar's MCP panel and `/mcp` show
  what is installed (`GET/POST /api/mcp`, `DELETE /api/mcp/:name`). maxcoding
  can call installed tools inside its tasks; in plan mode only tools the server
  marks `readOnlyHint` may run. Installs live in `FASTCAR_MCP_DIR`.
- **Purging old repos**: hover a repo for `×` (confirm, then delete), or use
  `/purge` — with no argument it lists repositories oldest-commit-first so stale
  clones are easy to spot, and `/purge <name>` removes one. A purge deletes the
  clone and deregisters it, and is **refused** while the clone holds
  uncommitted changes or commits that exist on no remote; the refusal names what
  is in the way and offers `--force` (the panel offers "Purge anyway"). Files are
  only ever deleted from inside `FASTCAR_REPOS_DIR` — a repository registered
  from elsewhere is deregistered and left on disk. The agent's `git_purge` tool
  never forces, so unsaved work can only be destroyed by you.
- **Code search**: the VM image ships [codegraph](https://github.com/Heyo-Computer/heyo-public/tree/main/codegraph),
  a tree-sitter symbol index the agents drive over bash — `codegraph --text
  search <name>` returns declarations (with kind, file, line) instead of every
  textual hit, `outline <file>` renders a 700-line file as ~45 signature lines,
  and `snippet <file> <symbol>` pulls one function instead of the whole file.
  It covers rust/python/js/ts symbols only, so grep still owns string literals,
  config, SQL, shell and markdown; the prompts say so. The server re-indexes a
  repo on clone/pull/checkout and local-ignores `.codegraph/` via
  `.git/info/exclude`, so the index never dirties the checkout or gets
  committed. Without the binary (a plain dev box) everything falls back to grep.
- **Memories** are saved to Postgres by the agent (`memory_save` etc.) and
  injected into its system prompt on new sessions.
- **Artifacts** — the agent publishes HTML pages and markdown documents with
  `create_artifact` / `update_artifact` / `list_artifacts` (users can also add
  them from the artifacts panel). Each one is served without authentication on
  the canonical path `/artifacts/<id>/<name>` (markdown is rendered to HTML;
  `?raw=1` returns the source), built into a full link from
  `FASTCAR_PUBLIC_URL`. Behind app-lb, `deploy/fastcar.json` lists `/artifacts/`
  in `auth.public_paths` so the links work for anyone who has them.
- While the agent is running, sending a message **steers** it; ◼ Stop aborts
  (cascading into any running subagents).

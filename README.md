# fastcar 🏎️

A multi-vendor agent harness built on the [Pi coding agent SDK](https://pi.dev)
(`@earendil-works/pi-coding-agent`): a **conductor** agent running on
InceptionLabs **Mercury** that routes work to subagents on **OpenRouter**, with
a Hermes-style dark web UI, Postgres-backed threads and memories, a
plan → approve → act workflow, blocking clarifying questions, Tavily web search,
and voice prompts via speech-to-text.

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
                     │   model: inceptionlabs/mercury-2          │
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
npm run smoke:git --workspace=@fastcar/server   # git clone/branch/commit/push round-trip
```

## Environment variables

| Var | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection | required |
| `INCEPTION_API_KEY` | Conductor model auth (Mercury) | required unless mock |
| `OPENROUTER_API_KEY` | Subagents + transcription | required unless mock |
| `MAXCODING_MODEL` | OpenRouter slug for the heavy coding subagent | `anthropic/claude-sonnet-4.5` |
| `MINIMODEL_MODEL` | OpenRouter slug for the fast/cheap subagent | `google/gemini-2.5-flash-lite` |
| `TRANSCRIBE_MODEL` | OpenRouter STT model | `openai/whisper-large-v3` |
| `TAVILY_API_KEY` | Web search | optional |
| `FASTCAR_WORKDIR` | Directory the agents operate on | process cwd |
| `FASTCAR_REPOS_DIR` | Where cloned repositories live | `<workdir>/repos` |
| `FASTCAR_GIT_NAME` / `FASTCAR_GIT_EMAIL` | Commit identity if the VM has no global git config | unset |
| `FASTCAR_DATA_DIR` | App state (Pi auth/models/sessions) — keep outside the workdir | `./.fastcar` |
| `FASTCAR_MOCK` | `1` = keyless mock mode | `0` |
| `FASTCAR_ENV_FILE` | Explicit env file to load instead of `.env` | unset |
| `PORT` | HTTP port | `3000` |

## Using it

- **Threads** live in the left sidebar (date-grouped); pick one on boot or
  start a new thread (or a new *plan* thread).
- **Tasks** are a chat message or an attached/dropped `.md` file (sent as the
  task specification). The 🎙️ button records a voice prompt and drops the
  transcript into the composer.
- **Planning mode**: the agent explores read-only (mutating tools are blocked
  per-call), may ask questions, then submits a plan. Approve to execute
  (thread flips to act mode); request changes to get a revision.
- **Questions**: when the agent calls `ask_user`, the thread pauses until you
  answer in the question card.
- **Subagents** appear nested inside the `run_subagent` tool card with live
  activity; the conductor receives their final reports.
- **Repositories**: the sidebar's Repositories panel lists every repo
  registered in the VM with live branch/dirty/ahead-behind status. "+" asks the
  agent to `git_clone` a URL — the clone runs in a visible thread. Agents get
  `git_clone` / `git_pull` / `git_checkout` / `git_commit` / `git_push` /
  `git_status` / `git_list_repos`; auth uses whatever the VM has (ssh keys,
  credential helper, or a token embedded in an https URL — prompts are
  disabled so bad auth fails fast instead of hanging).
- **Memories** are saved to Postgres by the agent (`memory_save` etc.) and
  injected into its system prompt on new sessions.
- While the agent is running, sending a message **steers** it; ◼ Stop aborts
  (cascading into any running subagents).

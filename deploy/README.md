# Deploying fastcar as a Firecracker microVM

Everything to run fastcar under [app-lb](https://github.com/heyo/heyo-public):
a heyvm-built Firecracker rootfs and the serverctl deployment that owns its
lifecycle.

```sh
./deploy/build-image.sh                # heyvm mvm build -> ~/.heyo/images/firecracker/fastcar.ext4
$EDITOR deploy/fastcar.json            # fill REPLACE_ME_* keys + the route host
serverctl apply -f deploy/fastcar.json
serverctl rollout status fastcar
serverctl exec fastcar -- /opt/fastcar/preflight.sh
```

| File | What it is |
| --- | --- |
| `image/Dockerfile` | The rootfs: Node 22 + Postgres + git + codegraph + the built app at `/opt/fastcar` |
| `image/Dockerfile.ruby` | Example *workspace* rootfs (not used by this deployment): Ubuntu 24.04 x86_64, Ruby 4.0.5 + Node 26.2.0 via mise, Postgres 16 + Redis in-guest, the native image/PDF toolchain, and `devservices` / `project-setup` for per-spawn bring-up of a Rails + Vite checkout |
| `image/init.sh` | PID 1: mounts, network, sshd, `/workspace` (data disk, or left to heyvmd for a managed workspace), local Postgres |
| `image/start.sh` | `vm.start_command` — the only place the app's env is read |
| `image/preflight.sh` | In-guest checks, run over `serverctl exec` |
| `image/resolv.conf` | Guest resolver, staged and copied at boot |
| `build-image.sh` | `heyvm mvm build` wrapper (context must be the repo root) |
| `fastcar.json` | The deployment spec |

## The configuration contract

**All env vars come from the deployment JSON** (`vm.env_vars`) — nothing is
baked into the image and there is no `.env` in the VM. heyvmd exports those
vars into the environment of `vm.start_command` (`/opt/fastcar/start.sh`),
which launches the server. Placeholders to replace before `serverctl apply`:

| Key | Placeholder |
| --- | --- |
| `INCEPTION_API_KEY` | `REPLACE_ME_INCEPTION_API_KEY` — conductor (Mercury) |
| `OPENROUTER_API_KEY` | `REPLACE_ME_OPENROUTER_API_KEY` — subagents + transcription |
| `TAVILY_API_KEY` | `REPLACE_ME_TAVILY_API_KEY` — web search |
| `routes[0].host` | `fastcar.example.com` — the public hostname |
| `FASTCAR_PUBLIC_URL` | `https://fastcar.example.com` — same host, with scheme; prefix of every public artifact URL |
| `auth.client_id` / `auth.allowed_domains` | the Google sign-in gate (see below); `client_secret` is a serverctl secret named `google` |
| `build.repo` | `https://github.com/REPLACE_ME_ORG/fastcar.git` — this repo's remote |
| `DATABASE_URL` | `postgres://fastcar:REPLACE_ME_DB_PASSWORD@db.example.com:5432/fastcar` — a Postgres **outside** the VM (see "State lives in the workspace") |
| `vm.workspace.store` | `https://REPLACE_ME_ARTIFACT_STORE` — the artifact store (or `s3://bucket/prefix`) that keeps `/workspace` snapshots; `auth` is a serverctl secret named `art` |

Model slugs (`MAXCODING_MODEL`, `MINIMODEL_MODEL`, `TRANSCRIBE_MODEL`) ship
with working defaults; change them in the same block. Rotate anything later
without editing the file:

```sh
serverctl set env fastcar OPENROUTER_API_KEY=sk-or-...   # rebuilds the pool
```

## Public artifacts

Agents publish HTML/markdown artifacts on `/artifacts/<id>/<name>` — links
meant to be opened by anyone without signing in. The app serves that prefix
with no auth of its own (ids are UUIDs; the URL is the capability), so the
only thing standing between a link and the world is app-lb's sign-in gate.
The spec's `auth.public_paths` therefore lists `/artifacts/` (and
`/api/health` for the pool's health checks) so the gate skips them; everything
else, `/api/*` and the UI included, stays behind Google sign-in. If you manage
the gate with `heyctl set auth` instead of the spec, add the same prefix:

```sh
heyctl set auth fastcar --public-path /api/health --public-path /artifacts/
```

`FASTCAR_PUBLIC_URL` must be the origin the browser uses (`https://` + the
route host) — it is what the agent pastes into its answers.

## Building the rootfs on the server

The spec's `build` block lets app-lb build the image itself — a git checkout of
this repo, `heyvm mvm build` on the app-lb host, and on success the job
rewrites `vm.image` to the new `fastcar-<short sha>` and rolls the pool:

```sh
serverctl build fastcar            # ship what's on the default branch
serverctl rollout status fastcar
```

Notes:

- `context` is `"."` on purpose: the Dockerfile COPYs the whole repo, and the
  default context (the Dockerfile's own directory) would break the first COPY.
- Omitting `ref` follows the remote's default branch; pin a branch, tag or
  commit with `"ref": "..."` when you want reproducible ships.
- Private repo? Store a token once and reference it — never inline it:
  `serverctl` secrets + `"auth": { "secret": "gh-token" }` in the build block
  (the key defaults to `token`). `ssh://`/`git@` remotes use the host's own
  keys instead and need no `auth`.
- The local path (`./deploy/build-image.sh` + `vm.image: "fastcar"`) still
  works and is what `vm.image` names until the first server-side build
  rewrites it.

## State lives in the workspace

heyvm recopies the rootfs from the base image on **every cold boot** — writes
to it do not survive. Everything stateful is pinned under `/workspace`:

- Pi session JSONL + auth/models → `/workspace/fastcar`
- Artifacts, browser-check screenshots, webhook tokens → `/workspace/fastcar/…`
- Cloned git repositories → `/workspace/repos`
- Logs → `/workspace/log` (`fastcar.log`, `postgres.log`)

There are two ways `/workspace` can be provided, and the spec picks one:

### `vm.workspace` — owned by the deployment (the shipped spec)

```json
"disk_size_gb": 40,
"workspace": {
  "store": "https://art.example.com",
  "ref": "fastcar-workspace",
  "auth": { "secret": "art", "key": "api_key" }
}
```

app-lb owns the directory. Every replica boots with `/workspace` seeded from
the deployment's latest snapshot, and whenever a replica retires — a
`serverctl build` rollout, `serverctl restart`, an edit to the spec, idling
under `idle_action: retain`, a `serverctl delete` — app-lb stops it, extracts
`/workspace`, and only then boots the replacement from the result. Each
snapshot is also pushed to the artifact store (or an `s3://bucket/prefix`)
under `ref`, so the workspace survives the host as well; a fresh host restores
it on the first boot. `disk_size_gb` is the workspace's capacity.
`serverctl describe fastcar` shows the snapshot in use, whether the store has
it, and what — if anything — is holding the pool while a capture runs.

Two things follow from how the capture works (app-lb rebuilds the tree as its
own user, not root):

- **Use an external `DATABASE_URL`.** File ownership does not survive a
  capture, and Postgres refuses a data directory it does not own, so `init.sh`
  does not start the in-guest cluster on a managed workspace. Point
  `DATABASE_URL` at a server outside the VM (the template's `REPLACE_ME_DB_PASSWORD`
  placeholder is for exactly that).
- `start.sh` sets `git config --global safe.directory '*'`, because git
  otherwise refuses repositories owned by another uid. Modes, symlinks and
  mtimes are preserved.

A rollout has a gap of drain + capture + boot — a minute or two for a few
gigabytes of repositories — which is inherent to one directory with one
writer; `max_replicas` must stay `1`.

### `disk_size_gb` alone — a per-VM data disk

Drop the `workspace` block and `vm.disk_size_gb` attaches a raw disk that
`init.sh` formats on first boot and mounts at `/workspace`, with the local
Postgres cluster in `/workspace/pgdata`. `idle_action: "retain"` keeps it
across idling, but the disk belongs to the *sandbox*: a rebuild, a restart or
a spec edit boots a new sandbox with an empty `/workspace`. Fine for a
throwaway; not for a harness whose sessions and repos are the point.

## Operating it

```sh
serverctl describe fastcar             # spec, pool, backends, traffic
serverctl top                          # CPU/memory
serverctl shell fastcar                # interactive shell in the guest
serverctl exec fastcar -- tail -50 /workspace/log/fastcar.log
serverctl restart fastcar              # recycle the VM
serverctl feed                         # deploy/issue events
```

Code search inside the VM: `/usr/local/bin/codegraph` is a tree-sitter symbol
index the agents use instead of grepping (built in a throwaway stage of the
Dockerfile from a pinned `CODEGRAPH_REF`; bump that ARG to upgrade it). The
server re-indexes a repository on clone/pull/checkout, and adds `.codegraph/` to
each repo's `.git/info/exclude` so the index never shows up in `git status` or
gets committed. Nothing depends on it: with the binary absent the agents fall
back to grep.

```sh
serverctl exec fastcar -- sh -c 'cd /workspace/repos/<name> && codegraph --text search <symbol>'
```

Git auth inside the VM: the agent's `git_clone`/`git_push` use whatever
credentials exist in the guest — embed a token in the https URL when adding a
repo, or `serverctl shell` in once and install an ssh key / credential helper
under `/workspace` (rootfs changes don't survive; with `vm.workspace`, a
credential helper or key kept under `/workspace` travels with the snapshot —
mind that it is then in the store too).

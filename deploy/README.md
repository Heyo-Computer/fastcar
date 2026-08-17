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
| `image/init.sh` | PID 1: mounts, network, sshd, data disk at `/workspace`, local Postgres |
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
| `build.repo` | `https://github.com/REPLACE_ME_ORG/fastcar.git` — this repo's remote |

Model slugs (`MAXCODING_MODEL`, `MINIMODEL_MODEL`, `TRANSCRIBE_MODEL`) ship
with working defaults; change them in the same block. Rotate anything later
without editing the file:

```sh
serverctl set env fastcar OPENROUTER_API_KEY=sk-or-...   # rebuilds the pool
```

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

## State lives on the data disk

heyvm recopies the rootfs from the base image on **every cold boot** — writes
to it do not survive. `vm.disk_size_gb` attaches a raw disk that `init.sh`
formats on first boot and mounts at `/workspace`. Everything stateful is
pinned there:

- Postgres cluster → `/workspace/pgdata` (threads, events, memories, repos registry)
- Pi session JSONL + auth/models → `/workspace/fastcar`
- Cloned git repositories → `/workspace/repos`
- Logs → `/workspace/log` (`fastcar.log`, `postgres.log`)

`idle_action: "retain"` in the scaling block stops idle VMs instead of
destroying them, so `/workspace` also survives idling. `DATABASE_URL` defaults
to the VM-local Postgres `init.sh` provisions; point it at an external server
in `env_vars` and the local one just idles.

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
under `/workspace` (rootfs changes don't survive; put keys in `/root/.ssh`
via a setup hook or use token URLs).

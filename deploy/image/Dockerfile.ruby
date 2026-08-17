# syntax=docker/dockerfile:1.7
# Ubuntu 24.04 x86_64 rootfs carrying *both* halves of fastcar-ruby: the fastcar
# harness (the server at /opt/fastcar, on :3000) and the Rails + Vite workspace
# an agent then works inside.
#
# It began as a pure workspace sibling of image/Dockerfile — that one builds the
# harness on node:22 and nothing else; this one built the environment a spawned
# VM hands to an agent, and COPYed no application at all. Running one image
# under the other's contract is what broke: deployments/ruby-fastcar.json builds
# this file but sets `vm.start_command: /opt/fastcar/start.sh` and health-checks
# :3000/api/health, so the guest booted cleanly, served nothing, and was killed
# at every boot_timeout_secs. The harness block near the end of this file is the
# merge; the two images are no longer interchangeable descriptions of the same
# job, and image/Dockerfile remains the slim harness-only build.
#
# So this rootfs is: Ruby and Node via mise, Postgres 16 and Redis in-guest, the
# native libraries Rails' usual suspects (pg, nokogiri, vips, imagemagick,
# poppler, qpdf) link against — and the fastcar server that drives them.
#
#     docker build --platform linux/amd64 -f deploy/image/Dockerfile.ruby -t fastcar-ruby .
#     heyvm mvm build --local-only -f deploy/image/Dockerfile.ruby -c . -n fastcar-ruby
#
# The *agent's* application still arrives per spawn by git clone into /workspace.
# What is COPYed is the harness and the boot block's
# deploy/image/{init.ruby.sh,resolv.conf}, so the context must be the repository
# root, not merely a valid directory. Requires BuildKit for the two COPY
# heredocs below (the default builder since Docker 23); on a legacy builder,
# split those scripts out into deploy/image/*.sh and COPY them like the sibling
# image does.
#
# The heyvm contract this inherits, and what each half costs here:
#
#   1. **Only the filesystem survives.** heyvm runs docker build, then
#      `docker create` + `docker export`, then mke2fs — ENV, CMD, ENTRYPOINT,
#      WORKDIR and USER are image *config* and are dropped. So no runtime
#      configuration below is expressed as ENV. The toolchain is reachable two
#      ways instead: /usr/local/bin symlinks that point straight at the real
#      binaries (env-independent, works under a bare `bash -c`), and
#      /etc/profile.d/10-toolchain.sh for login shells, which is what init.sh's
#      console shell and `serverctl shell` both get.
#
#   2. **The rootfs is recopied from the base image on every cold boot.** The
#      data disk mounted at /workspace is the only durable storage, so the
#      Postgres cluster, the Redis dump, the bundle path and the npm cache all
#      point there — see the bundler/npm block. The corollary is pleasant: the
#      rootfs is byte-identical after a cold boot, so gems compiled against
#      /opt/mise/installs/ruby/$RUBY_VERSION on the data disk stay ABI-valid
#      and a re-spawn skips recompiling them.
#
# On size. image/Dockerfile is slim on purpose, and the reason used to be a hard
# deadline: heyvmd copied the rootfs inside a synchronous 30s HTTP request, and
# ~26s of that budget went to a 2 GB image, so anything this large simply never
# booted. That ceiling is gone — `POST /sandbox-deploy` became asynchronous in
# heyvm 0.43.1, answering 202 and doing the copy on a task — which is what makes
# an image this size viable at all.
#
# It is still not free, just no longer fatal. This one cannot be slim: a
# from-source Ruby needs the full toolchain, the native gems need the -dev
# headers *at spawn time* (so build-essential and every -dev package here is
# load-bearing at runtime, not build-only), and the harness block at the end adds
# the fastcar server and its node_modules on top. Measure it after a change
# rather than trusting this line, and remember that the copy is paid on every
# cold boot as latency before the guest starts — roughly 13 s/GB on the ext4
# host us2 runs, where `reflink_or_copy` cannot FICLONE. Give a pool built on
# this image a boot_timeout_secs with room in it.
#
# One lever if it grows: `docker export` flattens the tree, so unlike normal
# image layers an `apt-get purge` in a later step really does shrink the
# exported rootfs. That is why rustc is installed, used to build Ruby, and
# purged in the same block rather than left behind.
#
# Build time is dominated by compiling Ruby: roughly 5-12 min on a native
# x86_64 builder, and most of a wall-clock hour under qemu emulation — so build
# this on the architecture it targets. The --platform pin below is explicit
# rather than inherited from the build host, because the mise and gh tarballs
# are fetched by exact architecture-bearing name and a host-follows build would
# quietly disagree with them.

# ---------------------------------------------------------------------------
# codegraph — tree-sitter code navigation, built in a throwaway stage and copied
# into the rootfs as a single stripped ~8.6 MB binary. The fastcar server shells
# out to it by bare name after a clone (services/git.ts), so it is not optional
# once the harness lives here; the ~1.3 GB Rust toolchain costs build time and
# zero rootfs bytes.
#
# Two pins that differ from the sibling image's copy of this stage, both because
# the runtime base below is Ubuntu noble rather than Debian bookworm:
#
#   * `--platform=linux/amd64`, which the sibling leaves to follow the build
#     host. It cannot follow it here: the runtime stage is pinned to amd64 and
#     asserts it, so a host-follows builder on arm64 would drop an arm64 binary
#     into an amd64 rootfs — an exec format error the first time an agent runs
#     it, and nothing before that would notice.
#   * The builder stays bookworm (glibc 2.36) while the runtime is noble (glibc
#     2.39), which is the safe direction and not merely the convenient one:
#     glibc is backward compatible, so a binary built against the older one runs
#     against the newer. Building this on noble and running it on bookworm is
#     what would fail, with a symbol version error. The `codegraph --version`
#     assertion in the app block below runs inside the noble image and is what
#     actually proves the pairing, rather than leaving it to this comment.
#
# CODEGRAPH_REF is pinned rather than tracking main: `heyvm mvm build` passes no
# --build-arg, so these defaults are the real configuration, and an unpinned ref
# would silently change the agents' search tool between image builds.
FROM --platform=linux/amd64 rust:1.97-slim-bookworm AS codegraph
ARG CODEGRAPH_REPO=https://github.com/Heyo-Computer/heyo-public.git
ARG CODEGRAPH_REF=0df9faba2d70242a2e231b8d15cf04e0feb690b6
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
RUN git init /src \
    && git -C /src remote add origin "$CODEGRAPH_REPO" \
    && git -C /src fetch --depth 1 origin "$CODEGRAPH_REF" \
    && git -C /src checkout FETCH_HEAD
WORKDIR /src/codegraph
# --locked builds the dependency set in the committed Cargo.lock and fails if it
# is stale, so the pinned commit fully determines the binary.
RUN rustc --version \
    && cargo build --release --locked \
    && strip target/release/codegraph \
    && ./target/release/codegraph --version

FROM --platform=linux/amd64 ubuntu:24.04

# Build-only. ENV would be dropped by docker export anyway, but ARG keeps that
# fact explicit — nothing here is meant to reach the guest.
ARG DEBIAN_FRONTEND=noninteractive

# Pinned toolchain versions. `heyvm mvm build` passes no --build-arg, so these
# defaults are the real configuration.
ARG RUBY_VERSION=4.0.5
ARG NODE_VERSION=26.2.0
ARG NPM_VERSION=11.13.0
ARG MISE_VERSION=2026.8.8
ARG GH_VERSION=2.96.0
# sha256 of the two prebuilt x86_64 tarballs, from each project's published
# checksum file. Pinned rather than fetched alongside the download: a checksum
# file served from the same origin as the artifact only catches corruption,
# while a digest recorded here catches the artifact changing under a tag.
# Both are architecture-specific — swapping the base arch means swapping these.
ARG MISE_SHA256=58edfbdba6d4255b6536a61daeaf3b21f7a059430c789e948c8494ba32d59e1f
ARG GH_SHA256=83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60

# The tarballs below are fetched by exact architecture-bearing name, and the
# libheif plugin check at the end of this file reads a multiarch path. A build
# that somehow lands on another architecture should fail here, not two hundred
# lines later with a checksum mismatch.
RUN test "$(dpkg --print-architecture)" = "amd64" \
    || { echo "this image is x86_64-only; build with --platform linux/amd64"; exit 1; }

# ---------------------------------------------------------------------------
# System packages
#
# Split into two apt invocations on purpose. This first one is everything the
# guest keeps: runtime libraries, the CLI tools, and every -dev package a
# native gem needs — those headers are *not* build-time here, because
# `bundle install` compiles pg/nokogiri/vips inside the VM on every spawn.
#
#   build-essential, pkg-config  — the per-spawn native gem builds
#   libpq-dev                    — pg (also supplies /usr/bin/pg_config)
#   libxml2-dev, libxslt1-dev    — nokogiri against system libxml2, see below
#   libvips-dev, libvips-tools   — ruby-vips / image_processing, plus the CLI
#   imagemagick                  — noble ships IM6: `convert`/`identify`, no `magick`
#   libheif + plugins            — HEIC/AVIF decode and encode for vips and IM.
#                                  noble splits the codecs into plugin packages;
#                                  libde265 and aomdec decode, x265 encodes.
#   qpdf, poppler-utils          — PDF repair/linearize and pdftotext/pdftoppm
#   libyaml-dev, libffi-dev      — psych and fiddle/FFI (Ruby 3.4+ stopped
#                                  vendoring libyaml; ruby-vips binds over FFI)
#   postgresql-16                — noble's default major, no PGDG repo needed
#   redis-server                 — cache/ActionCable/Sidekiq
#   tzdata, locales              — Rails wants a zoneinfo db, and Ruby derives
#                                  Encoding.default_external from the locale:
#                                  without a UTF-8 one it is US-ASCII
#   iproute2                     — init.ruby.sh brings eth0 up; the kernel's
#                                  ip= only assigns the address. Absent, the
#                                  guest boots with no network at all.
#   openssh-server               — sshd, started by init. openssh-client is the
#                                  wrong half: it has no /usr/sbin/sshd.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        pkg-config \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        iproute2 \
        openssh-client \
        openssh-server \
        procps \
        rsync \
        unzip \
        xz-utils \
        libssl-dev \
        zlib1g-dev \
        libyaml-dev \
        libffi-dev \
        libreadline-dev \
        libncurses-dev \
        libgdbm-dev \
        libgmp-dev \
        libdb-dev \
        uuid-dev \
        libpq-dev \
        libxml2-dev \
        libxslt1-dev \
        libvips-dev \
        libvips-tools \
        imagemagick \
        libheif1 \
        libheif-dev \
        libheif-examples \
        libheif-plugin-libde265 \
        libheif-plugin-aomdec \
        libheif-plugin-aomenc \
        libheif-plugin-x265 \
        libde265-dev \
        libx265-dev \
        aom-tools \
        x265 \
        qpdf \
        poppler-utils \
        postgresql-16 \
        postgresql-client-16 \
        redis-server \
        redis-tools \
        tzdata \
        locales \
    && rm -rf /var/lib/apt/lists/*

# UTF-8, generated at build time because locale-gen is slow and this would
# otherwise be paid on every cold boot. LANG itself is exported by the profile
# script and by both embedded scripts below — ENV would not survive the export.
# initdb also needs this locale to exist at boot, and it runs from the rootfs.
RUN sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen \
    && update-locale LANG=en_US.UTF-8

# The postgresql-16 package runs initdb at install time and leaves a `main`
# cluster in /var/lib/postgresql/16/main — i.e. on the rootfs, which is
# discarded on every cold boot. Drop it now so there is exactly one cluster in
# this image's world: the one devservices creates on the data disk. Left in
# place it is worse than dead weight, because `pg_ctlcluster`, psql's defaults
# and a stray `service postgresql start` would all find it, accept writes, and
# lose them at the next boot.
RUN if pg_lsclusters -h | grep -qE '^16[[:space:]]+main'; then \
        pg_dropcluster --stop 16 main; \
    fi

# ---------------------------------------------------------------------------
# mise — prebuilt x86_64 tarball, no installer script
#
# MISE_DATA_DIR is pointed at /opt/mise so the toolchains land somewhere
# system-wide rather than under /root, but that variable is a build-time ENV
# and does not survive the export. Two things make mise still work in the
# guest: the profile script re-exports it, and /root/.local/share/mise is
# symlinked at /opt/mise so mise finds its installs at the *default* path even
# with no environment at all. The global config goes to /etc/mise/config.toml,
# which mise reads as system config regardless of MISE_CONFIG_DIR.
#
# MISE_NODE_NPM_SHIM=0 turns off a mise feature that is actively hostile to the
# symlink scheme below. By default mise replaces node/bin/npm with its own bash
# wrapper (its job: run `mise reshim` after a global install) that locates npm
# with `dirname "${BASH_SOURCE[0]}"` — the path it was *invoked* through, not
# the realpath of the script. Reached through /usr/local/bin/npm that resolves
# to /usr/local/lib/node_modules/npm/bin/npm-cli.js, which does not exist, and
# every npm call dies with MODULE_NOT_FOUND. Verified by building this file
# with the shim on. Off, node/bin/npm is the stock symlink to npm-cli.js, which
# node resolves by realpath and which therefore survives being symlinked.
# The reshim it would have done for us is done explicitly instead — see
# relink-toolchain, which each install step below calls.
ENV MISE_DATA_DIR=/opt/mise \
    MISE_CONFIG_DIR=/etc/mise \
    MISE_YES=1 \
    MISE_NODE_NPM_SHIM=0
RUN set -eux; \
    curl -fsSL -o /tmp/mise.tar.gz \
        "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64.tar.gz"; \
    echo "${MISE_SHA256}  /tmp/mise.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/mise.tar.gz -C /tmp; \
    install -m 0755 /tmp/mise/bin/mise /usr/local/bin/mise; \
    rm -rf /tmp/mise /tmp/mise.tar.gz; \
    mkdir -p /etc/mise /opt/mise /root/.local/share; \
    ln -sfn /opt/mise /root/.local/share/mise; \
    mise settings set node.npm_shim false; \
    mise --version; \
    cat /etc/mise/config.toml

# ---------------------------------------------------------------------------
# Stable /usr/local/bin entry points
#
# The load-bearing half of "ENV does not survive docker export": symlinks that
# point at the real binaries, not at mise shims, so `ruby`, `node`, `bundle`
# and every gem/npm binstub resolve under a bare `bash -c` with a default PATH
# and no HOME — which is how an agent's tool calls and heyvmd's exec channel
# actually run commands. Ruby and Node both resolve their own prefix through
# the realpath of the executable, so a symlink does not confuse them.
#
# Defined here as a script, and re-run after *every* install below, because
# linking once at the end is not enough — and not merely for tidiness. npm's own
# binstub, and the agent CLIs', are `#!/usr/bin/env node` scripts: until `node`
# is on PATH they are all exit-127, which is how the first build of this file
# failed. Each install therefore links what it just produced, and the next step
# can use it by bare name.
#
# It stays in the image on purpose: install a global gem or npm package in a
# running VM and this is what puts its binstub on PATH.
RUN set -eux; \
    printf '%s\n' \
        '#!/bin/sh' \
        '# Refresh /usr/local/bin symlinks for the mise-installed toolchains.' \
        '# Run after installing a global gem or npm package.' \
        'set -eu' \
        "for d in /opt/mise/installs/ruby/${RUBY_VERSION}/bin /opt/mise/installs/node/${NODE_VERSION}/bin; do" \
        '    [ -d "$d" ] || continue' \
        '    for f in "$d"/*; do ln -sfn "$f" "/usr/local/bin/$(basename "$f")"; done' \
        'done' \
        > /usr/local/bin/relink-toolchain; \
    chmod 0755 /usr/local/bin/relink-toolchain

# ---------------------------------------------------------------------------
# Ruby, from source
#
# MISE_ALL_COMPILE=1 is what makes that true, and it is not optional here.
# Left to itself, mise resolves ruby@x to a *precompiled* tarball from its
# ruby.precompiled_url (jdx/ruby) and installs it in ~20s — verified by
# building this file without the flag, which produced a working
# `ruby 4.0.5 ... [x86_64-linux]` that was never compiled here at all. The flag
# forces the ruby-build path instead, which is what the -dev packages above and
# the compile-only packages here exist for. It is scoped to this one command
# rather than set globally: all_compile is a mise-wide setting, and Node has no
# business being compiled from source.
#
# autoconf/patch/bison are ruby-build's own prerequisites and stay: a few MB
# between them, and keeping them means `mise install ruby@<other>` still works
# inside the guest, which is the escape hatch for a repo that pins a different
# Ruby. rustc is a different proposition — several hundred MB with its
# dependencies, consulted only by ./configure to decide whether YJIT can be
# built — so it is purged in the same step. Because `docker export` flattens
# the tree, that purge really does come off the rootfs.
#
# YJIT is left to configure's own detection rather than forced with
# --enable-yjit, which would hard-fail the build if the toolchain were too old
# instead of quietly building without it. noble's rustc 1.75 turns out to be
# enough for 4.0.5 — the check below prints `YJIT compiled in: true` — but that
# is a fact about this Ruby and this Ubuntu, not a guarantee, which is why the
# check prints rather than asserts. A future Ruby that wants a newer rustc
# needs a rustup toolchain installed in this block.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends autoconf patch bison rustc; \
    rm -rf /var/lib/apt/lists/*; \
    MISE_ALL_COMPILE=1 \
    RUBY_CONFIGURE_OPTS="--disable-install-doc" \
    MAKE_OPTS="-j$(nproc)" \
        mise use --global "ruby@${RUBY_VERSION}"; \
    apt-get purge -y --auto-remove rustc; \
    rm -rf /opt/mise/downloads /opt/mise/cache /root/.cargo /tmp/ruby-build*; \
    relink-toolchain; \
    ruby -v; \
    ruby -e 'puts "YJIT compiled in: #{defined?(RubyVM::YJIT) ? true : false}"'

# ---------------------------------------------------------------------------
# Node — prebuilt tarball via the same mise, then npm pinned separately
#
# Node ships its own npm; the pin here is deliberate and independent, so the
# npm version is a decision this file makes rather than a side effect of the
# Node release. Installing npm as a global package into the node install's own
# prefix replaces the bundled copy in place — including its binstub, hence the
# second relink before npm is used by name.
RUN set -eux; \
    mise use --global "node@${NODE_VERSION}"; \
    rm -rf /opt/mise/downloads /opt/mise/cache; \
    relink-toolchain; \
    npm install -g --no-fund --no-audit "npm@${NPM_VERSION}"; \
    relink-toolchain; \
    node --version; \
    npm --version

# The agent CLIs. Unpinned on purpose — these move fast and a spawn is expected
# to get a current one — which does mean two builds of this file a week apart
# are not byte-identical. Pin them to exact versions here if that matters.
RUN set -eux; \
    npm install -g --no-fund --no-audit \
        @opencode-ai/cli \
        @anthropic-ai/claude-code; \
    npm cache clean --force; \
    relink-toolchain

RUN set -eux; \
    gem install --no-document bundler; \
    relink-toolchain; \
    mise reshim

# gh — prebuilt x86_64 tarball, binary and manpages only (the tarball's LICENSE
# at the root of /usr/local is the reason this is not a bare --strip-components
# extraction).
RUN set -eux; \
    curl -fsSL -o /tmp/gh.tar.gz \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /usr/local --strip-components=1 \
        "gh_${GH_VERSION}_linux_amd64/bin/gh" \
        "gh_${GH_VERSION}_linux_amd64/share/man"; \
    rm -f /tmp/gh.tar.gz; \
    gh --version

# ---------------------------------------------------------------------------
# Bundler and npm, configured to install onto the data disk
#
# Both configs are written to files under /root at build time, so they are part
# of the base image and survive every cold boot; what they point *at* is
# /workspace, which is the only thing that survives with its contents.
#
# The payoff is the second and later spawns in the same VM: the bundle path and
# the npm cache are still populated, and because the rootfs is recopied
# byte-identically, the gems' compiled extensions still match the Ruby at
# /opt/mise/installs/ruby/${RUBY_VERSION}. A first spawn still compiles.
#
# nokogiri is told to link the system libxml2/libxslt rather than vendor and
# compile its own copy — a couple of minutes off every first `bundle install`,
# and one libxml2 in the VM instead of two. pg is pointed at libpq-dev's
# pg_config so it never guesses from PATH.
RUN set -eux; \
    bundle config set --global path /workspace/cache/bundle; \
    bundle config set --global jobs "$(nproc)"; \
    bundle config set --global retry 3; \
    bundle config set --global build.nokogiri --use-system-libraries; \
    bundle config set --global build.pg --with-pg-config=/usr/bin/pg_config; \
    npm config set --global cache=/workspace/cache/npm; \
    npm config set --global fund=false

# ---------------------------------------------------------------------------
# Native gem smoke test
#
# The three gems whose build is most likely to be the thing that breaks a
# spawn, compiled here so a missing header fails *this build* rather than the
# first `bundle install` inside a VM an agent is already waiting on. Each is
# then loaded, which tests the other half — that the shared library it binds is
# present and matches.
#
# These land in the global gem home, not in the bundle path, so they are not a
# cache for `bundle install`: bundler installs the versions in the app's
# Gemfile.lock into /workspace/cache/bundle regardless. Their value is the
# proof, plus a working pg/vips for anything run outside bundler.
RUN set -eux; \
    gem install --no-document pg; \
    gem install --no-document nokogiri -- --use-system-libraries; \
    gem install --no-document ruby-vips; \
    ruby -rpg      -e 'puts "libpq #{PG.library_version}"'; \
    ruby -rnokogiri -e 'puts "nokogiri #{Nokogiri::VERSION} libxml2 #{Nokogiri::VERSION_INFO.dig("libxml", "loaded")}"'; \
    ruby -rvips    -e 'puts "libvips #{Vips::LIBRARY_VERSION}"'; \
    relink-toolchain; \
    mise reshim

# ---------------------------------------------------------------------------
# Login-shell environment
#
# The half of the toolchain wiring that gives mise its actual semantics. The
# shims directory comes first, so a repo that pins its own version in
# .ruby-version / .tool-versions / mise.toml is honoured — with the caveat that
# a pin mise has not installed makes the shim fail rather than fall back. The
# escape hatch is the /usr/local/bin symlinks above, which always resolve to
# the versions this image was built with, and `mise install` in the repo (a
# from-source Ruby, so: slow).
COPY <<'SH' /etc/profile.d/10-toolchain.sh
# Toolchain environment for login shells. Not the only path to the toolchain:
# /usr/local/bin holds symlinks to the same binaries for non-login shells.
export MISE_DATA_DIR=/opt/mise
export MISE_CONFIG_DIR=/etc/mise
export PATH="/opt/mise/shims:/usr/local/bin:$PATH"

export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# In-guest services, as devservices starts them. PGHOST points psql and the pg
# gem at the cluster's socket; the database *name* is left to the app.
#
# Deliberately no DATABASE_URL: Rails merges it over config/database.yml and it
# wins, so exporting a default here would silently retarget every environment
# of every app cloned into this VM — including `db:setup`, which would then
# create the wrong database. Set it per app when an app actually wants it.
export PGHOST=/var/run/postgresql
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/0}"

# Bundler/npm honour the config files under /root written at build time; these
# only matter for tools that read the environment instead.
export BUNDLE_PATH=/workspace/cache/bundle
export npm_config_cache=/workspace/cache/npm
SH

# ---------------------------------------------------------------------------
# In-VM services
#
# Postgres and Redis, both with their state on the data disk and both listening
# on loopback only. Idempotent, so it is safe as an init.sh call, a
# vm.start_command prelude, and a per-spawn precondition — project-setup calls
# it before touching the database.
#
# Postgres runs as the postgres user (it refuses to run as root) with the
# cluster at /workspace/pgdata; local auth is trust, because this is a
# single-tenant dev VM on loopback and Rails' default database.yml has no
# password in it. A role named after the invoking user is created so
# `bin/rails db:setup` and a bare `psql` work with no configuration at all.
COPY <<'SH' /usr/local/bin/devservices
#!/usr/bin/env bash
# Bring up the in-VM Postgres 16 + Redis. Idempotent; safe to call per spawn.
set -euo pipefail

export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

WORKSPACE="${WORKSPACE:-/workspace}"
PGDATA="${PGDATA:-$WORKSPACE/pgdata}"
PGBIN=/usr/lib/postgresql/16/bin
LOGDIR="$WORKSPACE/log"
SOCKDIR=/var/run/postgresql

# /workspace is the data disk. If it is not mounted, everything below still
# works and everything below is lost at the next cold boot — say so once.
mountpoint -q "$WORKSPACE" 2>/dev/null \
    || echo "devservices: warning: $WORKSPACE is not a mount; state will not survive a cold boot" >&2

mkdir -p "$LOGDIR" "$WORKSPACE/redis" "$PGDATA" "$SOCKDIR"

# postgres.log is created here, as root, and handed to the postgres user before
# anything writes to it. pg_ctl -l opens that file *as postgres*; a root-owned
# one left behind by the initdb redirect below makes the server fail to start
# with "could not start server" and a permission error in the middle of it.
touch "$LOGDIR/postgres.log"
chown postgres:postgres "$SOCKDIR" "$LOGDIR" "$LOGDIR/postgres.log" "$PGDATA"
chmod 700 "$PGDATA"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "devservices: initdb at $PGDATA (first boot)"
    su postgres -s /bin/sh -c \
        "$PGBIN/initdb -D '$PGDATA' -U postgres --auth-local=trust --auth-host=trust --encoding=UTF8 --locale=en_US.UTF-8" \
        >>"$LOGDIR/initdb.log" 2>&1
fi

if ! "$PGBIN/pg_isready" -q -h "$SOCKDIR" 2>/dev/null; then
    su postgres -s /bin/sh -c \
        "$PGBIN/pg_ctl -D '$PGDATA' -l '$LOGDIR/postgres.log' -w -t 60 \
         -o '-c listen_addresses=127.0.0.1 -c unix_socket_directories=$SOCKDIR' start"
fi

# A superuser role named after whoever runs this (root, in practice), so the
# default database.yml — no host, no user, no password — connects, and so
# `rails db:setup` is allowed to CREATE DATABASE.
APP_ROLE="${APP_DB_ROLE:-$(id -un)}"
if [ "$APP_ROLE" != "postgres" ]; then
    exists=$(su postgres -s /bin/sh -c \
        "$PGBIN/psql -qtAX -h $SOCKDIR -d postgres -c \"SELECT 1 FROM pg_roles WHERE rolname='$APP_ROLE'\"")
    if [ "$exists" != "1" ]; then
        su postgres -s /bin/sh -c \
            "$PGBIN/psql -qX -h $SOCKDIR -d postgres -c 'CREATE ROLE $APP_ROLE LOGIN SUPERUSER'"
    fi
fi

# Redis runs as root here rather than as the packaged redis user: single-tenant
# dev VM, loopback only, and its dir has to be writable on the data disk.
if ! redis-cli ping >/dev/null 2>&1; then
    redis-server /etc/redis/workspace.conf
    for _ in $(seq 1 30); do
        redis-cli ping >/dev/null 2>&1 && break
        sleep 0.2
    done
    redis-cli ping >/dev/null 2>&1 || { echo "devservices: redis did not come up, see $LOGDIR/redis.log" >&2; exit 1; }
fi

# $PGBIN/psql, not /usr/bin/psql: the latter is Debian's pg_wrapper, which
# resolves a cluster through /etc/postgresql — and this image deliberately has
# no registered cluster, only the one on the data disk.
pg_version=$("$PGBIN/psql" -qtAX -h "$SOCKDIR" -U "$APP_ROLE" -d postgres -c 'SHOW server_version' | tr -d ' ')
redis_version=$(redis-cli INFO server | awk -F: '/^redis_version/ { print $2 }' | tr -d '\r')
echo "devservices: postgres $pg_version + redis $redis_version up (data in $WORKSPACE)"

# For `docker run` and for use as a vm.start_command that must not return.
if [ "${1:-}" = "--foreground" ]; then
    exec tail -f "$LOGDIR/postgres.log"
fi
SH

# Redis config: loopback, state on the data disk, no systemd supervision. The
# packaged /etc/redis/redis.conf is left alone — nothing here starts it.
COPY <<'CONF' /etc/redis/workspace.conf
bind 127.0.0.1 -::1
port 6379
protected-mode yes
daemonize yes
supervised no
dir /workspace/redis
logfile /workspace/log/redis.log
pidfile /workspace/redis/redis.pid
save 900 1
appendonly no
CONF

# ---------------------------------------------------------------------------
# Per-spawn project bring-up
#
# The three commands a freshly cloned Rails + Vite checkout needs before an
# agent can run anything: bundle install (which compiles pg, nokogiri and vips
# against the headers installed above), npm install, and the database task.
#
#     project-setup /workspace/repos/<name>
#
# db:setup is what this runs by default, per the spec it was written to: create,
# load db/schema.rb, seed. It assumes the case it was designed for — a cloned
# repo with a committed schema — and exits non-zero in two others, both
# observed while testing this image:
#
#   * a second spawn against a retained data disk, where the database already
#     exists;
#   * an app with no db/schema.rb yet (a freshly generated one, or a repo whose
#     schema is not committed). db:setup creates both databases and *then*
#     fails with "schema.rb doesn't exist yet".
#
# RAILS_DB_TASK=db:prepare is the idempotent variant that handles all three:
# create if missing, migrate, seed only on create.
COPY <<'SH' /usr/local/bin/project-setup
#!/usr/bin/env bash
# Per-spawn: bundle install + npm install + rails db task, in one checkout.
set -euo pipefail

export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Make sure the toolchain is reachable without *reordering* PATH: called from a
# login shell, mise's shims stay in front and a repo's own .ruby-version is
# still honoured; called as a bare `bash -c` with a default PATH, the
# /usr/local/bin symlinks are what resolve ruby/node/bundle.
case ":$PATH:" in
    *":/usr/local/bin:"*) ;;
    *) PATH="/usr/local/bin:$PATH" ;;
esac
export PATH

APP_DIR="${1:-$PWD}"
cd "$APP_DIR"

# Postgres has to be up before the database task, and starting it is idempotent.
devservices >/dev/null

if [ -f Gemfile ]; then
    echo "==> bundle install (ruby $(ruby -e 'print RUBY_VERSION'))"
    mkdir -p "${BUNDLE_PATH:-/workspace/cache/bundle}"
    bundle install
fi

if [ -f package-lock.json ]; then
    echo "==> npm ci ($(node --version), npm $(npm --version))"
    # npm ci is the honest one for a lockfile, but it hard-fails when the
    # lockfile is out of sync with package.json — common on a feature branch,
    # and not a reason to leave the spawn without node_modules.
    npm ci || { echo "==> npm ci failed, falling back to npm install"; npm install; }
elif [ -f package.json ]; then
    echo "==> npm install ($(node --version), npm $(npm --version))"
    npm install
fi

if [ -f config/application.rb ]; then
    RAILS_DB_TASK="${RAILS_DB_TASK:-db:setup}"
    echo "==> rails $RAILS_DB_TASK"
    if [ -x bin/rails ]; then
        bin/rails "$RAILS_DB_TASK"
    else
        bundle exec rails "$RAILS_DB_TASK"
    fi
fi

echo "==> project-setup complete: $APP_DIR"
SH

RUN chmod 0755 /usr/local/bin/devservices /usr/local/bin/project-setup \
    && chmod 0644 /etc/redis/workspace.conf /etc/profile.d/10-toolchain.sh

# ---------------------------------------------------------------------------
# Build-time proof
#
# Every assertion here is something that otherwise fails inside a booted VM
# with an agent waiting on it — a wrong Ruby, a missing codec plugin, a gem
# that cannot find its shared library. The versions are asserted against the
# ARGs rather than merely printed, so a silently-floating upstream (a moved
# tag, a mise default) breaks the build instead of the spawn.
RUN set -eux; \
    test "$(ruby -e 'print RUBY_VERSION')" = "${RUBY_VERSION}"; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    test "$(npm --version)" = "${NPM_VERSION}"; \
    gh --version | grep -q "gh version ${GH_VERSION}"; \
    mise --version | grep -q "${MISE_VERSION}"; \
    bundle --version; \
    gem --version; \
    npm ls -g --depth=0 --json \
        | jq -e '.dependencies["@opencode-ai/cli"] and .dependencies["@anthropic-ai/claude-code"]' >/dev/null; \
    /usr/lib/postgresql/16/bin/postgres --version | grep -q " 16\."; \
    test ! -d /var/lib/postgresql/16/main; \
    redis-server --version; \
    vips --version; \
    identify -version | head -1; \
    qpdf --version | head -1; \
    command -v pdftoppm; \
    command -v pdftotext; \
    command -v aomdec; \
    command -v x265; \
    command -v heif-enc; \
    for plugin in libde265 aomdec aomenc x265; do \
        test -f "/usr/lib/x86_64-linux-gnu/libheif/plugins/libheif-${plugin}.so"; \
    done; \
    ruby -rpg -rnokogiri -rvips -e 'puts "native gems load"'; \
    echo "toolchain checks passed"

# The utilities the two embedded scripts call that arrive with the *base image*
# rather than an apt line above, so nothing names them and a base swap could
# drop one silently. Each failure is otherwise invisible until a spawn:
# without `su` Postgres never starts, without `mountpoint` devservices dies on
# its own warning path under `set -e`.
RUN for bin in su id awk sed tr seq tail mountpoint chown; do \
        command -v "$bin" >/dev/null || { echo "missing base utility: $bin"; exit 1; }; \
    done \
    && echo "base utility checks passed"

# ---------------------------------------------------------------------------
# The fastcar harness
#
# The half this image used to lack. The deployment that runs it names
# /opt/fastcar/start.sh as vm.start_command and health-checks :3000/api/health,
# and neither existed here — the guest booted perfectly, served nothing, and
# app-lb killed it at every boot_timeout_secs with `sh: 1:
# /opt/fastcar/start.sh: not found` in the guest's own log.
#
# Deliberately last. `COPY . /opt/fastcar` invalidates the build cache for
# everything below it on any change to any file in the repo, and what sits above
# is a from-source Ruby that costs 5-12 minutes to rebuild. Putting the app
# after the toolchain means an ordinary app commit rebuilds only this block.
#
# Node comes from mise (26.2.0 above), not the sibling image's node:22 base. The
# floor the app actually declares is >= 22.19 for the Pi SDK, so this satisfies
# it — but it is a *different* major than the sibling builds against, and the
# `npm run build` and `tsx --version` assertions below are what turn that from a
# hope into a build failure if a dependency disagrees.
COPY --from=codegraph /src/codegraph/target/release/codegraph /usr/local/bin/codegraph

# Context is the repo root; .dockerignore keeps node_modules, web/dist, .git and
# local state out, so the install below resolves from package-lock.json rather
# than inheriting whatever the build host had lying around.
COPY . /opt/fastcar
WORKDIR /opt/fastcar

# npm_config_cache overrides the /workspace/cache/npm this image configures
# globally further up. That path is the *data disk*, which does not exist at
# build time: left alone, the install would write its cache into the rootfs at
# /workspace/cache, where the data disk mount then hides it at runtime — bytes
# paid on every cold boot for a cache nothing can read. /tmp instead, removed in
# the same layer.
#
# devDependencies are kept, not pruned. `npm prune --omit=dev` would take tsx
# with it, and tsx is what start.sh runs the server through.
RUN set -eux; \
    npm_config_cache=/tmp/npm-build npm install --no-fund --no-audit; \
    npm_config_cache=/tmp/npm-build npm run build; \
    rm -rf /tmp/npm-build

# start.sh is the deployment's vm.start_command and the only place the app reads
# its env; preflight.sh is the manual health probe. Both arrive with the COPY
# above — these are the mode bits and the /opt/fastcar/* entry points the
# deployment and the runbooks name, which a git checkout does not guarantee.
RUN set -eux; \
    chmod +x /opt/fastcar/deploy/image/start.sh /opt/fastcar/deploy/image/preflight.sh; \
    ln -sf /opt/fastcar/deploy/image/start.sh /opt/fastcar/start.sh; \
    ln -sf /opt/fastcar/deploy/image/preflight.sh /opt/fastcar/preflight.sh

# Build-time proof for the app half, in the same spirit as the toolchain block
# above: each of these otherwise fails only once a VM is booted and app-lb is
# waiting on a health check that will never turn.
RUN set -eux; \
    test -x /opt/fastcar/start.sh; \
    test -x /opt/fastcar/preflight.sh; \
    node_modules/.bin/tsx --version; \
    test -f web/dist/index.html; \
    codegraph --version; \
    echo "fastcar app checks passed"

# ---------------------------------------------------------------------------
# Boot
#
# The load-bearing lines in this file. mvm-ctrl hardcodes `init=/init.sh` on
# the kernel cmdline (driver/firecracker.rs), so a rootfs without an executable
# at that exact path panics in kernel_execve with `Requested init /init.sh
# failed (error -2)` before a single line of userspace runs — which is exactly
# what this image did while CMD was its only declared entry point. CMD is image
# *config*: docker export drops it and the kernel never sees it.
COPY deploy/image/resolv.conf  /etc/heyo/resolv.conf
COPY deploy/image/init.ruby.sh /init.sh
RUN chmod +x /init.sh && chmod 0644 /etc/heyo/resolv.conf

# SSH host keys at build time so sshd does not block on entropy at first boot,
# and password auth written explicitly because there is no cloud-init later.
RUN mkdir -p /run/sshd /etc/ssh/sshd_config.d \
    && echo "PermitRootLogin yes" >> /etc/ssh/sshd_config \
    && echo "PermitEmptyPasswords yes" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication yes" > /etc/ssh/sshd_config.d/50-heyo.conf \
    && chmod 644 /etc/ssh/sshd_config.d/50-heyo.conf \
    && passwd -d root \
    && ssh-keygen -A

# Guard the contract above: a rename or a dropped COPY fails the build here
# rather than as a kernel panic in the autoscaler. The utilities are the ones
# init.ruby.sh calls that arrive with the *base image* or a package installed
# for another reason, so nothing else names them — without `ip` the guest has
# no network, without `blkid`/`mkfs.ext4` the data disk is never mounted and
# devservices refuses to start.
RUN test -x /init.sh \
    && for bin in ip blkid mkfs.ext4 hostname dmesg su mount mknod bash \
                  /usr/sbin/sshd /usr/local/bin/devservices; do \
        command -v "$bin" >/dev/null || { echo "missing boot dependency: $bin"; exit 1; }; \
    done \
    && echo "boot dependency checks passed"

# Documentation only — docker export drops both. 3000 is the fastcar server, and
# the port the deployment's vm.port proxies and health-checks; 5173 is Vite, for
# an agent running the workspace app's dev server. Rails would collide with
# fastcar on 3000 and has to be started on another port.
EXPOSE 22 3000 5173
CMD ["/init.sh"]

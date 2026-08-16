# Firecracker rootfs for the fastcar agent harness (server + built web UI +
# local Postgres), built with `heyvm mvm build`.
#
# heyvm does NOT run this as a container: it runs `docker build`, then
# `docker create` + `docker export`, then mke2fs over the exported tree. Only
# the *filesystem* survives — ENV, CMD, ENTRYPOINT, WORKDIR and USER are image
# config and are dropped. The real entry point is the kernel's `init=/init.sh`,
# and there is no systemd/cloud-init to fix anything up at runtime.
#
# Two consequences drive the layout:
#
#   1. **The rootfs is recopied from the base image on every cold boot.** The
#      only durable storage is the data disk (/dev/vdb, mounted by init.sh at
#      /workspace). Postgres's data dir, fastcar's Pi session JSONL, and cloned
#      repos therefore all live under /workspace — never on the rootfs.
#
#   2. **No env vars are baked here.** Configuration (API keys, model slugs,
#      DATABASE_URL) comes exclusively from the deployment JSON's vm.env_vars,
#      which heyvmd exports into the environment of vm.start_command
#      (/opt/fastcar/start.sh). init.sh only does system bring-up.
#
# Build (context must be the repo root — see deploy/build-image.sh):
#
#     ./deploy/build-image.sh
#     # or: heyvm mvm build --local-only -f deploy/image/Dockerfile -c . -n fastcar
#
# The result lands at ~/.heyo/images/firecracker/fastcar.ext4, which is what
# `vm.image` in deploy/fastcar.json names.

# node:22 on Debian bookworm: fastcar needs Node >= 22.19 (Pi SDK), and the
# official image's glibc userland boots fine under Firecracker. Pinned to the
# major only — the app pins its own dependencies via package-lock.json.
#
# -slim, and that is load-bearing rather than tidiness. heyvmd's
# `POST /sandbox-deploy` is fully synchronous — it copies this rootfs to
# run/<id>/rootfs.ext4 and boots the VM inside the HTTP request — while app-lb's
# SDK client gives that call 30s. The copy only avoids being a byte-for-byte
# read/write when the image store is on XFS-with-reflink or btrfs; on ext4 (what
# us2 runs) `reflink_or_copy` falls back to a full copy, measured at ~26s for the
# 2094 MB image the non-slim base produced. That overran the timeout on every
# single create, so the pool never got a VM and the deployment never came up —
# with no boot failure to show for it, because the guest was never reached.
#
# The full bookworm base carries ~760 MB of build toolchain (gcc, python3, the
# node-gyp prerequisites) that nothing here needs at runtime: every dependency
# below resolves to a prebuilt binary, so -slim builds clean. Measured on this
# tree: export tar 1691 MB -> 929 MB, rootfs 2094 MB -> 1178 MB, copy 26s -> 9s.
#
# Keep it small. Rootfs bytes are paid on every cold boot against that 30s
# budget, so anything added here is spent twice — once on disk, once on latency.
# Two things to reach for before the base image if it grows again: `postgresql`
# is only there for the *local* fallback DB and is dead weight whenever
# vm.env_vars sets an external DATABASE_URL, and `npm install` keeps the web
# build's devDependencies (vite, tailwind, typescript) in the runtime tree.
# Neither is free to remove — init.sh probes for initdb, and `npm prune
# --omit=dev` would take tsx with it, which start.sh runs the server through.
FROM node:22-bookworm-slim

# System deps, per heyvm image conventions plus fastcar's own needs:
#   iproute2        — init.sh brings eth0 up; the kernel's ip= only assigns it
#   openssh-server  — how `serverctl exec` / `serverctl shell` get in
#   e2fsprogs       — the data disk arrives raw; the guest runs mkfs.ext4 itself
#   ca-certificates — outbound TLS to InceptionLabs/OpenRouter/Tavily
#   git             — the whole point of the repos integration
#   postgresql      — local DB, data dir on /workspace (survives cold boots)
#   curl            — start.sh/preflight health probes
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        e2fsprogs \
        git \
        iproute2 \
        openssh-server \
        postgresql \
    && rm -rf /var/lib/apt/lists/*

# SSH access, per the heyvm image convention: root without a password, host
# keys generated at build time (boot-time keygen is slow on a microVM with
# little entropy and would be paid on every cold start).
RUN mkdir -p /run/sshd /etc/ssh/sshd_config.d \
    && echo "PermitRootLogin yes" >> /etc/ssh/sshd_config \
    && echo "PermitEmptyPasswords yes" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication yes" > /etc/ssh/sshd_config.d/50-heyo.conf \
    && chmod 644 /etc/ssh/sshd_config.d/50-heyo.conf \
    && passwd -d root \
    && ssh-keygen -A

# Staged resolver, copied over /etc/resolv.conf by init.sh. It cannot be
# written to /etc/resolv.conf at build time (Docker bind-mounts that path
# during builds), and it cannot be an ARG (`heyvm mvm build` passes no
# --build-arg through). Edit deploy/image/resolv.conf or let build-image.sh
# rewrite it from DNS_SERVER.
COPY deploy/image/resolv.conf /etc/heyo/resolv.conf

# The application. Context is the repo root; .dockerignore keeps node_modules,
# local state and build output out of the context so the install below is
# reproducible inside the image.
COPY . /opt/fastcar
WORKDIR /opt/fastcar
RUN npm install \
    && npm run build \
    && npm cache clean --force

# Boot and start scripts. init.sh is PID 1 (system bring-up only); start.sh is
# the deployment's vm.start_command and the ONLY place the app reads its env.
COPY deploy/image/init.sh /init.sh
COPY deploy/image/start.sh /opt/fastcar/deploy/image/start.sh
COPY deploy/image/preflight.sh /opt/fastcar/deploy/image/preflight.sh
RUN chmod +x /init.sh /opt/fastcar/deploy/image/start.sh /opt/fastcar/deploy/image/preflight.sh \
    && ln -sf /opt/fastcar/deploy/image/start.sh /opt/fastcar/start.sh \
    && ln -sf /opt/fastcar/deploy/image/preflight.sh /opt/fastcar/preflight.sh

# Build-time proof the load-bearing pieces exist — each otherwise fails only
# once a VM is booted and app-lb is waiting on a health check that never turns:
RUN test -x /init.sh \
    && test -x /usr/sbin/sshd \
    && test -x /usr/sbin/mkfs.ext4 \
    && node --version \
    && git --version \
    && ls /usr/lib/postgresql/*/bin/initdb \
    && node_modules/.bin/tsx --version \
    && test -f web/dist/index.html \
    && echo "image checks passed"

# The utilities init.sh and preflight.sh call that arrive with the *base image*
# rather than an apt line above, so nothing names them and a base swap can drop
# one silently. Each failure here is invisible until a VM is booted: without
# `hostname`/`dmesg` init.sh merely logs noise, but a missing `blkid` makes it
# reformat the data disk on every boot, and a missing `su` leaves Postgres
# unstarted while the guest still prints HEYVM_READY and passes its health check.
RUN for bin in hostname dmesg blkid su mountpoint; do \
        command -v "$bin" >/dev/null || { echo "missing base utility: $bin"; exit 1; }; \
    done \
    && echo "base utility checks passed"

# Documentation only — docker export drops both. 3000 is the guest port app-lb
# proxies and health-checks (vm.port in fastcar.json).
EXPOSE 3000
CMD ["/init.sh"]

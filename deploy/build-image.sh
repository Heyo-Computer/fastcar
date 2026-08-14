#!/bin/sh
# Build the fastcar Firecracker rootfs with heyvm.
#
# A wrapper over `heyvm mvm build` for one reason worth a script: the
# Dockerfile lives in deploy/image/ but COPYs the whole application, so the
# build context has to be the repo root. heyvm defaults the context to the
# Dockerfile's own directory, which would fail on the first COPY.
#
#   ./deploy/build-image.sh                       # -> image named fastcar
#   IMAGE_NAME=fastcar-staging ./deploy/build-image.sh
#   DNS_SERVER=10.0.0.53 ./deploy/build-image.sh  # internal resolver for the guest
#
# Env:
#   IMAGE_NAME   fastcar   must match vm.image in deploy/fastcar.json
#   DNS_SERVER   —         rewrites deploy/image/resolv.conf before building
#   SIZE_MB      —         rootfs size; default is auto (tar*1.2 + 64MB)
#   UPLOAD       —         set to 1 to also upload to the cloud (needs auth)
#
# This sizes the *rootfs* (node, postgres binaries, the app). All state —
# Postgres data, Pi sessions, cloned repos — lives on the deployment's data
# disk (vm.disk_size_gb), so growing state never means rebuilding the image.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-fastcar}"

for tool in docker mke2fs heyvm; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        if [ "$tool" = "mke2fs" ]; then
            echo "build-image.sh: mke2fs not found; install e2fsprogs" >&2
        else
            echo "build-image.sh: $tool not found on PATH" >&2
        fi
        exit 1
    fi
done

# heyvm shells out to fakeroot unless the build runs as root, so root
# ownership in the Docker-exported tar survives into the ext4 image.
if [ "$(id -u)" -ne 0 ] && ! command -v fakeroot >/dev/null 2>&1; then
    echo "build-image.sh: fakeroot not found; install fakeroot or build as root" >&2
    exit 1
fi

# The resolver is a COPY'd file, not a build arg — `heyvm mvm build` passes no
# --build-arg through, so an ARG would silently keep its default.
if [ -n "${DNS_SERVER:-}" ]; then
    printf '# Written by build-image.sh (DNS_SERVER=%s)\nnameserver %s\n' \
        "$DNS_SERVER" "$DNS_SERVER" > "$ROOT/deploy/image/resolv.conf"
    echo "resolver set to $DNS_SERVER"
fi

set -- -f "$ROOT/deploy/image/Dockerfile" -c "$ROOT" -n "$IMAGE_NAME"
if [ -n "${SIZE_MB:-}" ]; then
    set -- "$@" --size-mb "$SIZE_MB"
fi
if [ "${UPLOAD:-}" != "1" ]; then
    set -- "$@" --local-only
fi

echo "building $IMAGE_NAME (context: $ROOT)"
heyvm mvm build "$@"

cat <<EOF

Built: ~/.heyo/images/firecracker/$IMAGE_NAME.ext4

Next — fill the placeholders and register the deployment:

  1. Edit deploy/fastcar.json:
       - routes[0].host              -> your real hostname
       - env_vars REPLACE_ME_*       -> real keys (all config lives here)
  2. serverctl apply -f $ROOT/deploy/fastcar.json
  3. serverctl rollout status fastcar
  4. serverctl exec fastcar -- /opt/fastcar/preflight.sh

Rotate a key later without touching the file on disk:

  serverctl set env fastcar OPENROUTER_API_KEY=sk-or-...
EOF

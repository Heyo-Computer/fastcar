#!/bin/sh
# The deployment's vm.start_command. heyvmd runs this through the guest's
# serial shell with the deployment JSON's vm.env_vars exported — this is the
# ONLY place fastcar's configuration enters the VM. Nothing is baked into the
# image and init.sh reads none of it.
#
# Launches the server in the background and returns once it answers its health
# check (or fails loudly), so it behaves the same whether the host treats the
# start command as fire-and-forget or waits for it.
set -u

LOG=/workspace/log/fastcar.log
# On the rootfs, deliberately. The rootfs is recopied from the image on every
# cold boot, so a pid recorded here can only belong to *this* boot. It used to
# live at /workspace/fastcar.pid, and under vm.workspace that directory is
# captured when a VM retires and restored into its replacement — the pid file
# travelled with it. PIDs are handed out in almost the same order every boot,
# and the previous VM's server was forked at just the point in that sequence
# where the replacement runs this script, so the number was often live again
# (this script's own shell, heyvmd's log writer…). The guard below then said
# "already running", nothing listened on $PORT, app-lb reaped the VM at
# boot_timeout_secs, captured the same file, and the next replacement rolled
# the same dice. (us2, 2026-09-03: "fastcar already running (pid 300)" from a
# VM whose pid file was older than its own boot.)
PIDFILE=/run/fastcar.pid
mkdir -p /workspace/log
# A snapshot taken from an older image still carries the stale copy. Drop it so
# it stops travelling; nothing reads it any more.
rm -f /workspace/fastcar.pid

# With vm.workspace, /workspace is captured and rebuilt by app-lb as its own
# user between VMs, so every file under it comes back owned by that uid. git
# treats a repository owned by somebody else as suspect ("dubious ownership")
# and refuses to touch it; the agent runs as root and the repos are its own,
# so tell git so. Harmless on the plain data-disk layout.
git config --global --add safe.directory '*' 2>/dev/null || true

# Paths default onto the data disk — the rootfs is discarded on cold boot.
# Everything else (keys, model slugs, DATABASE_URL…) must come from the
# deployment env; these fallbacks only pin state to /workspace.
export PORT="${PORT:-3000}"
export FASTCAR_DATA_DIR="${FASTCAR_DATA_DIR:-/workspace/fastcar}"
export FASTCAR_WORKDIR="${FASTCAR_WORKDIR:-/workspace}"
export FASTCAR_REPOS_DIR="${FASTCAR_REPOS_DIR:-/workspace/repos}"
export DATABASE_URL="${DATABASE_URL:-postgres://fastcar:fastcar@127.0.0.1:5432/fastcar}"

# Already running (warm start / repeated hook)? Leave it be.
#
# "Running" means a live process whose command line is our server — `kill -0`
# alone is satisfied by whatever process inherited the number. The health
# probe covers the case with no usable pid file at all: a second server on a
# port that already answers would only die on EADDRINUSE after racing the
# first one through migrate().
is_fastcar() {
    [ -n "${1:-}" ] \
        && tr '\0' ' ' 2>/dev/null < "/proc/$1/cmdline" | grep -q 'server/src/index.ts'
}
if is_fastcar "$(cat "$PIDFILE" 2>/dev/null)"; then
    echo "fastcar already running (pid $(cat "$PIDFILE"))"
    exit 0
fi
if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "something already answers /api/health on :${PORT}; not starting a second server"
    exit 0
fi

# If DATABASE_URL points at the local instance, wait for init.sh's *backgrounded*
# bring-up to finish. Waiting here rather than in init.sh is deliberate: init.sh
# runs inside heyvmd's create call, which app-lb gives 30s, while this script
# runs after the VM is ready and only has to beat boot_timeout_secs (300s).
#
# The flag, not pg_isready: the cluster accepts connections a moment before the
# fastcar role and database exist, and migrate() would race in through that gap
# and fail on a database that is not there yet. init.sh touches /run/pg-ready
# only after provisioning, so this waits for the condition we actually need.
case "$DATABASE_URL" in
    *127.0.0.1*|*localhost*)
        for i in $(seq 1 120); do
            [ -f /run/pg-ready ] && break
            sleep 1
        done
        [ -f /run/pg-ready ] || echo "warning: local postgres not ready after 120s; see /workspace/log/pg-bringup.log"
        ;;
esac

cd /opt/fastcar
# tsx runs the TypeScript server directly; migrations run inside index.ts.
# Output to the log file, never the serial console (it would corrupt the
# host's exec marker protocol).
nohup node_modules/.bin/tsx server/src/index.ts >>"$LOG" 2>&1 &
echo $! > "$PIDFILE"

for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
        echo "fastcar up on :${PORT} (pid $(cat "$PIDFILE"))"
        exit 0
    fi
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break
    sleep 1
done

echo "fastcar failed to become healthy; last log lines:"
tail -20 "$LOG" 2>/dev/null
exit 1

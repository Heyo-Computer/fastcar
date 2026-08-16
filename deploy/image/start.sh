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
PIDFILE=/workspace/fastcar.pid
mkdir -p /workspace/log

# Paths default onto the data disk — the rootfs is discarded on cold boot.
# Everything else (keys, model slugs, DATABASE_URL…) must come from the
# deployment env; these fallbacks only pin state to /workspace.
export PORT="${PORT:-3000}"
export FASTCAR_DATA_DIR="${FASTCAR_DATA_DIR:-/workspace/fastcar}"
export FASTCAR_WORKDIR="${FASTCAR_WORKDIR:-/workspace}"
export FASTCAR_REPOS_DIR="${FASTCAR_REPOS_DIR:-/workspace/repos}"
export DATABASE_URL="${DATABASE_URL:-postgres://fastcar:fastcar@127.0.0.1:5432/fastcar}"

# Already running (warm start / repeated hook)? Leave it be.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "fastcar already running (pid $(cat "$PIDFILE"))"
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

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

# If DATABASE_URL points at the local instance init.sh started, wait for it.
case "$DATABASE_URL" in
    *127.0.0.1*|*localhost*)
        PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1)
        for i in $(seq 1 30); do
            [ -n "$PGBIN" ] && su postgres -s /bin/sh -c "$PGBIN/pg_isready -h 127.0.0.1" >/dev/null 2>&1 && break
            sleep 1
        done
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

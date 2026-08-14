#!/bin/sh
# In-guest checks for what an HTTP health check cannot see. Run from the host:
#   serverctl exec fastcar -- /opt/fastcar/preflight.sh
set -u
FAIL=0
note() { echo "$1"; }
bad()  { echo "FAIL: $1"; FAIL=1; }

mountpoint -q /workspace 2>/dev/null \
    && note "ok: /workspace is a real mount (data disk)" \
    || bad "/workspace is NOT a mount — all state is on the discardable rootfs"

[ -f /workspace/pgdata/PG_VERSION ] \
    && note "ok: postgres data dir on the data disk" \
    || note "warn: no local pg cluster (fine if DATABASE_URL is external)"

PID=$(cat /workspace/fastcar.pid 2>/dev/null)
[ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null \
    && note "ok: fastcar running (pid $PID)" \
    || bad "fastcar process not running"

curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null 2>&1 \
    && note "ok: health endpoint answers" \
    || bad "health endpoint not answering on :${PORT:-3000}"

# The env contract: the app's process must have its config from the deployment.
if [ -n "${PID:-}" ] && [ -r "/proc/$PID/environ" ]; then
    for key in DATABASE_URL INCEPTION_API_KEY OPENROUTER_API_KEY; do
        if tr '\0' '\n' < "/proc/$PID/environ" | grep -q "^$key="; then
            if tr '\0' '\n' < "/proc/$PID/environ" | grep -q "^$key=REPLACE_ME"; then
                bad "$key is still a REPLACE_ME placeholder"
            else
                note "ok: $key present in the server's environment"
            fi
        else
            bad "$key missing from the server's environment"
        fi
    done
fi

df -h /workspace 2>/dev/null | tail -1
exit $FAIL

#!/bin/sh
# PID 1 for the Rails workspace microVM (Dockerfile.ruby).
#
# A sibling of init.sh, not a copy of it. That one is PID 1 for the fastcar
# harness and provisions the `fastcar` role/database inline; this image's
# services belong to devservices, which also brings up Redis and initdbs with
# the en_US.UTF-8 locale the image generates at build time. Running init.sh
# here would initdb /workspace/pgdata first, with neither, and devservices
# would then find PG_VERSION and skip its own setup — a non-UTF-8 cluster and
# no Redis, both silent.
#
# The one hard contract with the host: print `HEYVM_READY` on the serial
# console when the VM is up, then leave a shell reading from it. Anything
# printed to the console after HEYVM_READY that is not part of a marked command
# corrupts that protocol, so every service logs to a file.

mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null

# A Docker-exported rootfs has an empty /dev; if devtmpfs is unavailable these
# must exist for sshd, node (entropy) and postgres.
if [ ! -c /dev/null ]; then
    echo "init: devtmpfs unavailable, creating device nodes manually"
    mknod -m 666 /dev/null    c 1 3
    mknod -m 666 /dev/zero    c 1 5
    mknod -m 444 /dev/random  c 1 8
    mknod -m 444 /dev/urandom c 1 9
    mknod -m 666 /dev/tty     c 5 0
    mknod -m 666 /dev/ptmx    c 5 2
    ln -sf /proc/self/fd /dev/fd
fi
mkdir -p /dev/pts && mount -t devpts devpts /dev/pts
mkdir -p /dev/shm && mount -t tmpfs -o mode=1777 tmpfs /dev/shm 2>/dev/null

mkdir -p /tmp && chmod 1777 /tmp

# Kernel messages would otherwise interleave with the serial command protocol.
dmesg -n 1 2>/dev/null

if [ -f /etc/heyo/resolv.conf ]; then
    cp /etc/heyo/resolv.conf /etc/resolv.conf
else
    echo "nameserver 8.8.8.8" > /etc/resolv.conf
fi

hostname rails-workspace

# The kernel's ip= parameter assigns the address but nothing brings the link up.
ip link set eth0 up 2>/dev/null
if ! ip addr show eth0 2>/dev/null | grep -q "inet "; then
    for param in $(cat /proc/cmdline); do
        case "$param" in
            ip=*)
                GUEST_IP="${param#ip=}"; GUEST_IP="${GUEST_IP%%::*}"
                TAIL="${param#*::}"; GW="${TAIL%%:*}"
                ip addr add "$GUEST_IP/30" dev eth0 2>/dev/null
                [ -n "$GW" ] && ip route add default via "$GW" dev eth0 2>/dev/null
                ;;
        esac
    done
fi

# --- The data disk --------------------------------------------------------
#
# The rootfs is recopied from the base image on every cold boot; /workspace
# (the raw /dev/vdb the deployment's disk_size_gb creates) is the only storage
# that survives. The pg cluster, the bundle path and the npm cache all live
# under it — see the bundler/npm block in Dockerfile.ruby. Format on first
# boot, decided by inspection: a flag file would live on the rootfs and vanish.
DATA_READY=0
if [ -b /dev/vdb ]; then
    if ! blkid /dev/vdb >/dev/null 2>&1; then
        echo "init: /dev/vdb has no filesystem, creating ext4 (first boot)"
        mkfs.ext4 -F -m0 -L heyo-data /dev/vdb >/tmp/mkfs.log 2>&1 \
            || echo "init: mkfs.ext4 failed, see /tmp/mkfs.log"
    fi
    mkdir -p /workspace
    if mount -t ext4 -o rw,noatime /dev/vdb /workspace 2>/tmp/mount.log; then
        DATA_READY=1
    else
        echo "init: mounting /dev/vdb on /workspace failed, see /tmp/mount.log"
    fi
else
    echo "init: no /dev/vdb — the deployment is missing vm.disk_size_gb"
fi
mkdir -p /workspace/log

# --- sshd -----------------------------------------------------------------
mkdir -p /run/sshd
chown root:root /run/sshd && chmod 755 /run/sshd
chmod 600 /etc/ssh/ssh_host_*_key 2>/dev/null
chmod 644 /etc/ssh/ssh_host_*_key.pub 2>/dev/null
/usr/sbin/sshd -D -e 2>/tmp/sshd.log &

# --- Postgres + Redis, via devservices ------------------------------------
#
# Backgrounded, and that is the load-bearing part — the same trap init.sh
# documents for the harness image. heyvmd's create call blocks on the
# HEYVM_READY marker below and app-lb's SDK client allows the whole call 30s,
# rootfs copy and boot included. devservices on a first boot runs initdb, then
# pg_ctl start, then polls pg_isready; in the foreground that overruns the
# budget on its own, every create times out, and each retry gets a fresh
# sandbox id and therefore a fresh empty data disk — so it is first-boot every
# time and the deployment can never converge.
#
# Output goes to a log, never the console: anything printed after HEYVM_READY
# that is not part of a marked command corrupts the host's serial protocol.
# /run/devservices-ready is touched last, for a start_command that needs to
# wait on the database; /run is on the rootfs, recopied every cold boot, so the
# flag cannot be stale.
#
# Two flags, not one, because this image now serves two masters. `pg-ready` is
# the harness's: deploy/image/start.sh waits on it — and only when DATABASE_URL
# actually names this instance — before launching the fastcar server. init.sh
# (the harness's PID 1) touches it; this file did not, so a fastcar deployment
# pointed at the in-guest Postgres would stall the full 120s and start anyway.
#
# It is touched *after* the role/database step rather than straight after
# devservices, because that is what start.sh reads it to mean: not "the cluster
# accepts connections" but "the thing DATABASE_URL names actually exists".
# Touching it any earlier would trade a loud 120s wait for a silent
# authentication failure on the app's first connect.
if [ "$DATA_READY" = "1" ]; then
    (
        /usr/local/bin/devservices || exit 1
        touch /run/devservices-ready

        # The `fastcar` role and database the harness's default DATABASE_URL
        # (postgres://fastcar:fastcar@127.0.0.1:5432/fastcar) names. A no-op for
        # a deployment whose env supplies an external DATABASE_URL, which is the
        # common case — but it costs one idempotent psql call, and it is the
        # whole difference between the local fallback working and not.
        #
        # No password ceremony here, unlike init.sh: devservices initdbs with
        # `--auth-local=trust --auth-host=trust`, so the loopback TCP connection
        # the app makes is trusted and the PASSWORD below only exists to satisfy
        # the URL. Run over the socket via $PGBIN/psql rather than /usr/bin/psql
        # — the latter is Debian's pg_wrapper, and this image deliberately
        # registers no cluster for it to resolve.
        #
        # Idempotent on both halves: a cluster provisioned on an earlier boot, or
        # half-provisioned by a failure between the two statements, must not
        # wedge every boot after it. CREATE DATABASE cannot run inside a DO
        # block, hence \gexec for that half.
        PGBIN=/usr/lib/postgresql/16/bin
        "$PGBIN/psql" -qX -h /var/run/postgresql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fastcar') THEN
    CREATE ROLE fastcar LOGIN PASSWORD 'fastcar';
  END IF;
END $$;
SELECT 'CREATE DATABASE fastcar OWNER fastcar'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'fastcar')\gexec
SQL
        touch /run/pg-ready
    ) >/workspace/log/devservices-bringup.log 2>&1 &
else
    echo "init: refusing to start devservices without a mounted /workspace;" \
         "the cluster would land on the rootfs and vanish on the next cold boot"
fi

echo "HEYVM_READY"

# A loop, not `exec`: the serial console is the only exec channel this VM has.
# If the shell exits, exec would leave the VM alive but unreachable.
#
# `bash --login` rather than `sh`, matching init.sh in the harness image, so
# /etc/profile.d/10-toolchain.sh is sourced and mise's shims are on PATH — the
# whole point of that file. Note the heyo base images deliberately use `sh`
# here instead, because an interactive bash can mangle marker-delimited
# `heyvm exec` parsing; the harness image runs bash through app-lb without
# trouble, so this follows its precedent. If exec against this image starts
# timing out at 30s, that difference is the first thing to suspect.
while :; do /bin/bash --login; sleep 0.1; done

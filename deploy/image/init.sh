#!/bin/sh
# PID 1 for the fastcar microVM. System bring-up ONLY — the application is
# started by heyvmd via the deployment's vm.start_command (start.sh), which is
# where the deployment JSON's env_vars are in scope. Nothing here reads or
# assumes any fastcar configuration.
#
# The one hard contract with the host: print `HEYVM_READY` on the serial
# console when the VM is up, then leave a shell reading from it — that shell is
# how `serverctl exec`, the start command and health-side inspection all run.
# Anything printed to the console after HEYVM_READY that is not part of a
# marked command corrupts that protocol, so every service logs to a file.

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

hostname fastcar

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
# that survives. Postgres data, Pi session JSONL, memories… everything stateful
# lands under it. Format on first boot, decided by inspection — a flag file
# would live on the rootfs and vanish.
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

# --- Postgres (backgrounded — must NOT delay HEYVM_READY) -----------------
#
# Started here (not in start.sh) so the DB is up regardless of how the app is
# launched, with its data dir on the data disk. If the deployment's
# DATABASE_URL points at an external server instead, this local instance just
# idles — harmless. Refuses to run without a mounted /workspace: a cluster on
# the rootfs would pass every check and lose all data on the next cold boot.
#
# Backgrounded, and that is the load-bearing part. heyvmd's create call blocks
# on the HEYVM_READY marker below and app-lb's SDK client allows the whole call
# 30s — rootfs copy, boot and init included. First-boot provisioning here
# (initdb, then pg_ctl start, then a pg_isready poll that can burn 30s by
# itself) ran *before* the marker and blew that budget on its own, so every
# create timed out, no VM ever joined the pool, and app-lb reported a transport
# error with no boot failure to point at. Each retry got a fresh sandbox id and
# therefore a fresh empty data disk, so it was first-boot every time — the
# deployment could never converge.
#
# Output goes to a log, never the console: anything printed after HEYVM_READY
# that is not part of a marked command corrupts the host's serial protocol.
# The subshell touches /run/pg-ready last; start.sh waits on that (and only
# when DATABASE_URL actually names this instance). /run is on the rootfs, which
# is recopied from the base image every cold boot, so the flag cannot be stale.
if [ "$DATA_READY" = "1" ]; then
    (
        PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1)
        PGDATA=/workspace/pgdata
        if [ -n "$PGBIN" ]; then
            mkdir -p "$PGDATA" && chown -R postgres:postgres "$PGDATA" /workspace/log
            if [ ! -f "$PGDATA/PG_VERSION" ]; then
                echo "initdb (first boot)"
                su postgres -s /bin/sh -c "$PGBIN/initdb -D $PGDATA --auth=md5 --auth-local=trust --username=postgres"
            fi
            # /run is recreated on every cold boot, so the socket directory the
            # Debian package ships is not there any more by the time we start.
            mkdir -p /run/postgresql && chown postgres:postgres /run/postgresql
            su postgres -s /bin/sh -c "$PGBIN/pg_ctl -D $PGDATA -l /workspace/log/postgres.log -o '-c listen_addresses=127.0.0.1' start"
            # First boot: the fastcar role/database the default DATABASE_URL names.
            #
            # Over the unix socket, never `-h 127.0.0.1`. initdb above sets
            # `--auth-local=trust` but `--auth=md5`, so a TCP connection as
            # postgres demands a password that is never set — this step used to
            # die with `fe_sendauth: no password supplied`, so the role and
            # database were never created and the app failed its first connect
            # with `password authentication failed for user "fastcar"`. The
            # socket is the trusted path; the app still reaches Postgres over
            # TCP, which is what the md5 line is for.
            if [ ! -f "$PGDATA/.fastcar-provisioned" ]; then
                for i in $(seq 1 60); do
                    su postgres -s /bin/sh -c "$PGBIN/pg_isready" >/dev/null 2>&1 && break
                    sleep 1
                done
                # Idempotent: a partially-provisioned cluster (role created, then
                # the database step failed) must not wedge every later boot on a
                # "role already exists" error. CREATE DATABASE cannot run inside
                # a DO block, hence \gexec for that half.
                su postgres -s /bin/sh -c "$PGBIN/psql -v ON_ERROR_STOP=1 -d postgres" <<'SQL' \
                    && touch "$PGDATA/.fastcar-provisioned"
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fastcar') THEN
    CREATE ROLE fastcar LOGIN PASSWORD 'fastcar';
  END IF;
END $$;
SELECT 'CREATE DATABASE fastcar OWNER fastcar'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'fastcar')\gexec
SQL
            fi
            # Only now is the cluster both up and provisioned.
            touch /run/pg-ready
        else
            echo "postgresql binaries not found"
        fi
    ) >/workspace/log/pg-bringup.log 2>&1 &
else
    echo "init: refusing to start postgres without a mounted /workspace;" \
         "its data would land on the rootfs and vanish on the next cold boot"
fi

echo "HEYVM_READY"

# A loop, not `exec /bin/sh`: the serial console is the only exec channel this
# VM has. If the shell exits, exec would leave the VM alive but unreachable.
while :; do /bin/bash --login; sleep 0.1; done

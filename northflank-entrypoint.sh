#!/bin/sh
set -eu

# Northflank-specific wrapper. Keep all platform-specific diagnostics and
# constraints here so Railway's production entrypoint remains untouched.
export DEPLOY_PLATFORM="northflank"
export OPENCODE_TELEGRAM_HOME="${OPENCODE_TELEGRAM_HOME:-/data}"

if [ "$OPENCODE_TELEGRAM_HOME" != "/data" ]; then
  printf '%s\n' "[northflank] FATAL: OPENCODE_TELEGRAM_HOME must be /data for this image" >&2
  exit 1
fi

mkdir -p /data
if [ ! -w /data ]; then
  printf '%s\n' "[northflank] FATAL: /data is not writable; check the persistent-volume mount permissions" >&2
  exit 1
fi

# A Northflank persistent volume can preserve modes from an earlier pod. A
# recursive chown alone is not enough if a directory/file lost its owner-write
# bit. OpenCode writes its internal log below XDG_DATA_HOME, so normalize only
# the state paths that the non-root `node` runtime must mutate.
OPENCODE_STATE_DIR="/data/.local/share/opencode"
OPENCODE_INTERNAL_LOG_DIR="$OPENCODE_STATE_DIR/log"
mkdir -p \
  /data/logs \
  /data/run \
  /data/.config \
  /data/.local/share \
  /data/.cache \
  /data/opencode \
  /data/workspace \
  "$OPENCODE_INTERNAL_LOG_DIR"

chown -R node:node \
  /data/logs \
  /data/run \
  /data/.config \
  /data/.local \
  /data/.cache \
  /data/opencode \
  /data/workspace

# Preserve group/other policy while guaranteeing the runtime owner can create,
# modify and traverse its persisted state after a pod replacement/redeploy.
find /data/logs /data/run /data/.config /data/.local /data/.cache /data/opencode /data/workspace \
  -type d -exec chmod u+rwx {} +
find /data/logs /data/run /data/.config /data/.local /data/.cache /data/opencode /data/workspace \
  -type f -exec chmod u+rw {} +

# Fail before the bot starts if the exact OpenCode log path is still unusable.
# This makes volume/ACL failures explicit instead of producing an opaque
# OpenCode `code=1` restart loop.
if ! su -s /bin/sh node -c 'test -w /data/.local/share/opencode/log && : > /data/.local/share/opencode/log/.northflank-write-test && rm -f /data/.local/share/opencode/log/.northflank-write-test'; then
  printf '%s\n' "[northflank] FATAL: node cannot write ${OPENCODE_INTERNAL_LOG_DIR}; check Northflank volume ownership/ACLs" >&2
  ls -ld /data /data/.local /data/.local/share "$OPENCODE_STATE_DIR" "$OPENCODE_INTERNAL_LOG_DIR" >&2 2>/dev/null || true
  exit 1
fi

printf '%s\n' "[northflank] Runtime bootstrap starting"
printf '%s\n' "[northflank] Persistent data path: /data"
printf '%s\n' "[northflank] OpenCode state write check: OK (${OPENCODE_INTERNAL_LOG_DIR})"
printf '%s\n' "[northflank] For persistence, mount a Northflank volume at /data"

# process.ts intentionally redirects the OpenCode child stderr to a persistent
# file. Mirror that file into the Northflank pod logs so startup failures are
# observable without changing shared TypeScript code or Railway behavior.
(
  LOG_FILE="/data/logs/opencode-server.stderr.log"
  while [ ! -f "$LOG_FILE" ]; do
    sleep 1
  done
  tail -n 0 -F "$LOG_FILE" 2>/dev/null | while IFS= read -r line; do
    printf '%s\n' "[northflank][opencode-stderr] $line" >&2
  done
) &

exec /app/northflank-runtime.sh

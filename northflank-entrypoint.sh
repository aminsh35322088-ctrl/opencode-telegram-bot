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

printf '%s\n' "[northflank] Runtime bootstrap starting"
printf '%s\n' "[northflank] Persistent data path: /data"
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

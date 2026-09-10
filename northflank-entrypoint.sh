#!/bin/sh
set -eu

# Northflank-specific wrapper. The heavy runtime bootstrap is shared with the
# proven production container logic, while this file remains the platform
# boundary for Northflank-specific behaviour.
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

exec /app/northflank-runtime.sh

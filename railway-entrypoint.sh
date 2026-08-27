#!/bin/sh
set -eu

: "${OPENCODE_API_URL:=http://127.0.0.1:4096}"
: "${OPENCODE_AUTO_RESTART_ENABLED:=true}"
: "${OPENCODE_AUTO_START_IN_CONTAINER:=true}"
: "${OPENCODE_MONITOR_INTERVAL_SEC:=60}"
: "${OPENCODE_MODEL_PROVIDER:=opencode}"
: "${OPENCODE_MODEL_ID:=big-pickle}"
: "${OPEN_BROWSER_ROOTS:=/app/workspace}"

export OPENCODE_API_URL OPENCODE_AUTO_RESTART_ENABLED OPENCODE_AUTO_START_IN_CONTAINER
export OPENCODE_MONITOR_INTERVAL_SEC OPENCODE_MODEL_PROVIDER OPENCODE_MODEL_ID OPEN_BROWSER_ROOTS

# Railway attaches the persistent volume after the image is built, so the
# ownership set in Dockerfile may not survive the mount. Fix it as root before
# dropping to the unprivileged node user.
mkdir -p /data/logs /data/run /data/.config /data/.local/share /data/.cache /app/workspace
chown -R node:node /data /app/workspace

printf '%s\n' "[railway] OpenCode Telegram Bot starting"
printf '%s\n' "[railway] OpenCode CLI: $(opencode --version 2>/dev/null || echo unknown)"
printf '%s\n' "[railway] OpenCode API: ${OPENCODE_API_URL}"
printf '%s\n' "[railway] Auto-start: ${OPENCODE_AUTO_START_IN_CONTAINER}"
printf '%s\n' "[railway] Workspace: ${OPEN_BROWSER_ROOTS}"

# Run the application unprivileged after repairing the mounted volume.
exec su -s /bin/sh node -c 'exec node /app/dist/index.js'

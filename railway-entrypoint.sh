#!/bin/sh
set -eu

# Runtime configuration is fixed in the image. Only the two Telegram
# credentials are expected as Railway environment variables. GitHub/Railway
# integrations are loaded from the bot's persistent Integrations store.
OPENCODE_API_URL="http://127.0.0.1:4096"
OPENCODE_AUTO_RESTART_ENABLED="true"
OPENCODE_AUTO_START_IN_CONTAINER="true"
OPENCODE_MONITOR_INTERVAL_SEC="60"
OPENCODE_MODEL_PROVIDER="opencode"
OPENCODE_MODEL_ID="big-pickle"
OPEN_BROWSER_ROOTS="/data/workspace"
OPENCODE_CONFIG_DIR="/data/.config/opencode"
OPENCODE_TELEGRAM_WORKSPACE="/data/workspace"
OPENCODE_EXPERIMENTAL_LSP_TOOL="true"
OPENCODE_ENABLE_EXA="1"
PLAYWRIGHT_BROWSERS_PATH="/opt/ms-playwright"
OPENCODE_DATA_VOLUME_BUDGET_MB="${OPENCODE_DATA_VOLUME_BUDGET_MB:-500}"
OPENCODE_DATA_VOLUME_WARN_MB="${OPENCODE_DATA_VOLUME_WARN_MB:-150}"
OPENCODE_DATA_VOLUME_CRITICAL_MB="${OPENCODE_DATA_VOLUME_CRITICAL_MB:-100}"

# Never rely on or persist integration credentials through Railway variables.
# These are only compatibility guardrails for the process environment; the
# bot loads active credentials from the persistent application state file.
unset GH_TOKEN GITHUB_TOKEN RAILWAY_TOKEN RAILWAY_API_TOKEN 2>/dev/null || true
GH_HOST="${GH_HOST:-github.com}"
GH_PROMPT_DISABLED="1"
export OPENCODE_API_URL OPENCODE_AUTO_RESTART_ENABLED OPENCODE_AUTO_START_IN_CONTAINER
export OPENCODE_MONITOR_INTERVAL_SEC OPENCODE_MODEL_PROVIDER OPENCODE_MODEL_ID OPEN_BROWSER_ROOTS
export OPENCODE_CONFIG_DIR OPENCODE_TELEGRAM_WORKSPACE OPENCODE_EXPERIMENTAL_LSP_TOOL OPENCODE_ENABLE_EXA PLAYWRIGHT_BROWSERS_PATH
export OPENCODE_DATA_VOLUME_BUDGET_MB OPENCODE_DATA_VOLUME_WARN_MB OPENCODE_DATA_VOLUME_CRITICAL_MB
export GH_HOST GH_PROMPT_DISABLED

GLOBAL_OPENCODE_DIR="/data/.config/opencode"
GLOBAL_TOOLS_DIR="$GLOBAL_OPENCODE_DIR/tools"
INTEGRATION_STATE_FILE="${OPENCODE_TELEGRAM_HOME:-/data}/app-state.json"
INTEGRATION_BIN_DIR="/data/run/integration-bin"
GH_ACCOUNTS_DIR="/data/.config/gh/accounts"
mkdir -p /data/logs /data/run /data/.config /data/.local/share /data/.cache /data/opencode /data/workspace "$GLOBAL_TOOLS_DIR" "$INTEGRATION_BIN_DIR" "$GH_ACCOUNTS_DIR"

# Clean only disposable caches automatically. Never delete workspaces,
# sessions, databases, source files, or generated user artifacts here.
rm -rf /data/.cache/npm /data/.npm /data/.cache/tsx /data/.cache/opencode

# Publish the real persistent-volume state to every OpenCode session through
# stable environment variables and startup diagnostics.
DATA_FREE_KB="$(df -Pk /data | awk 'NR==2 {print $4}')"
DATA_USED_KB="$(df -Pk /data | awk 'NR==2 {print $3}')"
DATA_TOTAL_KB="$(df -Pk /data | awk 'NR==2 {print $2}')"
DATA_FREE_MB="$((DATA_FREE_KB / 1024))"
DATA_USED_MB="$((DATA_USED_KB / 1024))"
DATA_TOTAL_MB="$((DATA_TOTAL_KB / 1024))"
printf '%s\n' "[railway] Persistent volume: total=${DATA_TOTAL_MB}MB used=${DATA_USED_MB}MB free=${DATA_FREE_MB}MB budget=${OPENCODE_DATA_VOLUME_BUDGET_MB}MB warn=${OPENCODE_DATA_VOLUME_WARN_MB}MB critical=${OPENCODE_DATA_VOLUME_CRITICAL_MB}MB"
if [ "$DATA_FREE_MB" -lt "$OPENCODE_DATA_VOLUME_CRITICAL_MB" ]; then
  printf '%s\n' "[railway] WARNING: /data is below the critical free-space threshold; disk-heavy validation is blocked" >&2
elif [ "$DATA_FREE_MB" -lt "$OPENCODE_DATA_VOLUME_WARN_MB" ]; then
  printf '%s\n' "[railway] WARNING: /data is below the warning free-space threshold; use /tmp for disposable validation data"
fi

# OpenCode's global AGENTS.md is loaded into the initial instruction context
# of every session, before the first user message is sent to the model.
# Keep the image-baked project contract in the exact XDG global location that
# OpenCode discovers automatically; do not rely on the session workspace.
if [ ! -f /app/AGENTS.md ]; then
  printf '%s\n' "[railway] FATAL: /app/AGENTS.md is missing from the image" >&2
  exit 1
fi
cp /app/AGENTS.md "$GLOBAL_OPENCODE_DIR/AGENTS.md"
chown node:node "$GLOBAL_OPENCODE_DIR/AGENTS.md"
AGENTS_SHA="$(sha256sum "$GLOBAL_OPENCODE_DIR/AGENTS.md" | awk '{print $1}')"
AGENTS_LINES="$(wc -l < "$GLOBAL_OPENCODE_DIR/AGENTS.md" | tr -d ' ')"
printf '%s\n' "[railway] Global AGENTS.md loaded: ${GLOBAL_OPENCODE_DIR}/AGENTS.md (${AGENTS_LINES} lines, sha256=${AGENTS_SHA})"

if [ -e /app/workspace ] && [ ! -L /app/workspace ]; then
  if [ -d /app/workspace ] && [ "$(find /app/workspace -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    printf '%s\n' "[railway] Migrating image-local workspace contents to persistent volume"
    cp -a /app/workspace/. /data/workspace/
  fi
  rm -rf /app/workspace
fi
ln -sfn /data/workspace /app/workspace

if [ -e /tmp/site ] && [ ! -L /tmp/site ]; then
  if [ -d /tmp/site ] && [ "$(find /tmp/site -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    printf '%s\n' "[railway] Migrating legacy /tmp/site contents to persistent workspace"
    cp -a /tmp/site/. /data/workspace/
  fi
  rm -rf /tmp/site
fi
ln -sfn /data/workspace /tmp/site

if [ -d /app/.opencode/tools ]; then
  cp -a /app/.opencode/tools/. "$GLOBAL_TOOLS_DIR/"
  chown -R node:node "$GLOBAL_TOOLS_DIR"
fi

if [ -f /app/opencode.json ]; then
  cp /app/opencode.json "$GLOBAL_OPENCODE_DIR/opencode.json"
  chown node:node "$GLOBAL_OPENCODE_DIR/opencode.json"
fi

cat > "$INTEGRATION_BIN_DIR/gh" <<'EOF'
#!/bin/sh
set -eu
STATE_FILE="${OPENCODE_TELEGRAM_HOME:-/data}/app-state.json"
TOKEN=""
ACCOUNT_ID="github"
if [ -f "$STATE_FILE" ]; then
  TOKEN="$(jq -r '(.integrations.github // {}) as $g | (($g.accounts // []) | map(select(.id == $g.activeId)) + ($g.accounts // [])) | .[0].token // empty' "$STATE_FILE" 2>/dev/null || true)"
  ACCOUNT_ID="$(jq -r '(.integrations.github // {}) as $g | (($g.accounts // []) | map(select(.id == $g.activeId)) + ($g.accounts // [])) | .[0].id // "github"' "$STATE_FILE" 2>/dev/null || echo github)"
fi

# Keep the bot's persistent account selection authoritative for every gh call.
# GH_TOKEN is the documented headless authentication mechanism and takes
# precedence over any stale credentials in a gh config directory.
GH_CONFIG_DIR="/data/.config/gh/accounts/$ACCOUNT_ID"
mkdir -p "$GH_CONFIG_DIR"
chmod 700 "$GH_CONFIG_DIR"
export GH_CONFIG_DIR

if [ -n "$TOKEN" ]; then
  GH_TOKEN="$TOKEN"
  GITHUB_TOKEN="$TOKEN"
  export GH_TOKEN GITHUB_TOKEN
else
  unset GH_TOKEN GITHUB_TOKEN 2>/dev/null || true
fi

exec /usr/bin/gh "$@"
EOF

cat > "$INTEGRATION_BIN_DIR/railway" <<'EOF'
#!/bin/sh
set -eu
STATE_FILE="${OPENCODE_TELEGRAM_HOME:-/data}/app-state.json"
TOKEN=""
TOKEN_TYPE=""
if [ -f "$STATE_FILE" ]; then
  TOKEN_TYPE="$(jq -r '(.integrations.railway // {}) as $r | (($r.accounts // []) | map(select(.id == $r.activeId)) + ($r.accounts // [])) | .[0].tokenType // empty' "$STATE_FILE" 2>/dev/null || true)"
  TOKEN="$(jq -r '(.integrations.railway // {}) as $r | (($r.accounts // []) | map(select(.id == $r.activeId)) + ($r.accounts // [])) | .[0].token // empty' "$STATE_FILE" 2>/dev/null || true)"
fi
if [ -n "$TOKEN" ]; then
  if [ "$TOKEN_TYPE" = "project" ]; then
    RAILWAY_TOKEN="$TOKEN"
    unset RAILWAY_API_TOKEN 2>/dev/null || true
    export RAILWAY_TOKEN
  else
    RAILWAY_API_TOKEN="$TOKEN"
    unset RAILWAY_TOKEN 2>/dev/null || true
    export RAILWAY_API_TOKEN
  fi
else
  unset RAILWAY_TOKEN RAILWAY_API_TOKEN 2>/dev/null || true
fi
exec /usr/local/bin/railway "$@"
EOF
chmod 700 "$INTEGRATION_BIN_DIR/gh" "$INTEGRATION_BIN_DIR/railway"
chown node:node "$INTEGRATION_BIN_DIR/gh" "$INTEGRATION_BIN_DIR/railway"

cat > /data/run/github-credential-helper.sh <<'EOF'
#!/bin/sh
set -eu
STATE_FILE="${OPENCODE_TELEGRAM_HOME:-/data}/app-state.json"
TOKEN=""
if [ -f "$STATE_FILE" ]; then
  TOKEN="$(jq -r '(.integrations.github // {}) as $g | (($g.accounts // []) | map(select(.id == $g.activeId)) + ($g.accounts // [])) | .[0].token // empty' "$STATE_FILE" 2>/dev/null || true)"
fi
if [ -n "$TOKEN" ]; then
  printf '%s\n' 'username=x-access-token'
  printf 'password=%s\n' "$TOKEN"
fi
EOF
chmod 700 /data/run/github-credential-helper.sh
chown node:node /data/run/github-credential-helper.sh

chown -R node:node /data

su -s /bin/sh node -c 'git config --global credential.https://github.com/.helper /data/run/github-credential-helper.sh'
su -s /bin/sh node -c 'git config --global credential.https://github.com/.useHttpPath false'

printf '%s\n' "[railway] OpenCode Telegram Bot starting"
printf '%s\n' "[railway] OpenCode CLI: $(opencode --version 2>/dev/null || echo unknown)"
printf '%s\n' "[railway] OpenCode API: ${OPENCODE_API_URL}"
printf '%s\n' "[railway] Auto-start: ${OPENCODE_AUTO_START_IN_CONTAINER}"
printf '%s\n' "[railway] Workspace: ${OPEN_BROWSER_ROOTS}"
printf '%s\n' "[railway] Persistent shared workspace: /data/workspace"
printf '%s\n' "[railway] OpenCode default cwd: ${OPENCODE_TELEGRAM_WORKSPACE}"
printf '%s\n' "[railway] OpenCode config dir: ${OPENCODE_CONFIG_DIR}"
printf '%s\n' "[railway] Global tool dir: ${GLOBAL_TOOLS_DIR}"
printf '%s\n' "[railway] Agent tools: $(find "$GLOBAL_TOOLS_DIR" -maxdepth 1 -name '*.ts' -type f 2>/dev/null | wc -l) custom tools"
printf '%s\n' "[railway] Playwright CLI: $(playwright-cli --version 2>/dev/null || echo unavailable)"
printf '%s\n' "[railway] Toolchain: node=$(node --version), python=$(python3 --version 2>/dev/null || echo unavailable), git=$(git --version), gh=$(/usr/bin/gh --version 2>/dev/null | head -1 || echo unavailable), railway=$(/usr/local/bin/railway --version 2>/dev/null || echo unavailable)"
printf '%s\n' "[railway] GitHub/Railway integrations: credentials loaded dynamically from persistent bot state"

export PATH="$INTEGRATION_BIN_DIR:$PATH"

cd "$OPENCODE_TELEGRAM_WORKSPACE"
exec su -s /bin/sh node -c 'export PATH="/data/run/integration-bin:$PATH"; cd "$OPENCODE_TELEGRAM_WORKSPACE" && exec node /app/dist/index.js'

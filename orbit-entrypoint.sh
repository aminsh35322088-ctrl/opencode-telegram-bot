#!/bin/sh
set -eu

log() { printf '%s\n' "[orbit] $*"; }
fatal() { printf '%s\n' "[orbit] FATAL: $*" >&2; exit 1; }

umask 077

APP_ROOT="${ORBIT_APP_ROOT:-$(pwd)}"
STATE_ROOT="${ORBIT_STATE_DIR:-/app/.orbit-state}"
WORKSPACE="${OPENCODE_TELEGRAM_WORKSPACE:-$STATE_ROOT/workspace}"
GLOBAL_OPENCODE_DIR="$STATE_ROOT/.config/opencode"
GLOBAL_TOOLS_DIR="$GLOBAL_OPENCODE_DIR/tools"
INTEGRATION_BIN_DIR="$STATE_ROOT/run/integration-bin"
GH_ACCOUNTS_DIR="$STATE_ROOT/.config/gh/accounts"

[ -f "$APP_ROOT/dist/index.js" ] || fatal "compiled entrypoint not found: $APP_ROOT/dist/index.js"
[ -f "$APP_ROOT/AGENTS.md" ] || fatal "AGENTS.md not found: $APP_ROOT/AGENTS.md"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || fatal "TELEGRAM_BOT_TOKEN is not set"
[ -n "${TELEGRAM_ALLOWED_USER_ID:-}" ] || fatal "TELEGRAM_ALLOWED_USER_ID is not set"

mkdir -p \
  "$STATE_ROOT/logs" "$STATE_ROOT/run" "$STATE_ROOT/.config" \
  "$STATE_ROOT/.local/share" "$STATE_ROOT/.cache" "$STATE_ROOT/opencode" \
  "$WORKSPACE" "$GLOBAL_TOOLS_DIR" "$INTEGRATION_BIN_DIR" "$GH_ACCOUNTS_DIR"

WRITE_TEST="$STATE_ROOT/.orbit-write-test.$$"
if ! (umask 077 && : > "$WRITE_TEST" && rm -f "$WRITE_TEST"); then
  fatal "state directory is not writable: $STATE_ROOT"
fi
chmod -R u+rwX "$STATE_ROOT" 2>/dev/null || true

export DEPLOY_PLATFORM="orbit"
export NODE_ENV="production"
export OPENCODE_TELEGRAM_HOME="$STATE_ROOT"
export HOME="$STATE_ROOT"
export XDG_CONFIG_HOME="$STATE_ROOT/.config"
export XDG_DATA_HOME="$STATE_ROOT/.local/share"
export XDG_CACHE_HOME="$STATE_ROOT/.cache"
export OPENCODE_HOME="$STATE_ROOT/opencode"
export OPEN_BROWSER_ROOTS="$WORKSPACE"
export OPENCODE_TELEGRAM_WORKSPACE="$WORKSPACE"
export OPENCODE_CONFIG_DIR="$GLOBAL_OPENCODE_DIR"
export OPENCODE_RUNTIME_NODE_DEPS="$APP_ROOT/node_modules"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"
export OPENCODE_API_URL="${OPENCODE_API_URL:-http://127.0.0.1:4096}"
export OPENCODE_AUTO_RESTART_ENABLED="${OPENCODE_AUTO_RESTART_ENABLED:-true}"
export OPENCODE_AUTO_START_IN_CONTAINER="${OPENCODE_AUTO_START_IN_CONTAINER:-true}"
export OPENCODE_MONITOR_INTERVAL_SEC="${OPENCODE_MONITOR_INTERVAL_SEC:-20}"
export OPENCODE_MODEL_PROVIDER="${OPENCODE_MODEL_PROVIDER:-opencode}"
export OPENCODE_MODEL_ID="${OPENCODE_MODEL_ID:-big-pickle}"
export OPENCODE_EXPERIMENTAL_LSP_TOOL="${OPENCODE_EXPERIMENTAL_LSP_TOOL:-true}"
export OPENCODE_ENABLE_EXA="${OPENCODE_ENABLE_EXA:-1}"
export OPENCODE_DATA_VOLUME_BUDGET_MB="${OPENCODE_DATA_VOLUME_BUDGET_MB:-5120}"
export OPENCODE_DATA_VOLUME_WARN_MB="${OPENCODE_DATA_VOLUME_WARN_MB:-768}"
export OPENCODE_DATA_VOLUME_CRITICAL_MB="${OPENCODE_DATA_VOLUME_CRITICAL_MB:-384}"
export GH_HOST="${GH_HOST:-github.com}"
export GH_PROMPT_DISABLED="1"

unset GH_TOKEN GITHUB_TOKEN RAILWAY_TOKEN RAILWAY_API_TOKEN 2>/dev/null || true
rm -rf "$STATE_ROOT/.npm" "$STATE_ROOT/.cache/tsx" "$STATE_ROOT/.cache/opencode" 2>/dev/null || true

if [ ! -d "$OPENCODE_RUNTIME_NODE_DEPS" ]; then
  fatal "runtime dependency tree is missing: $OPENCODE_RUNTIME_NODE_DEPS"
fi
if [ -e "$WORKSPACE/node_modules" ] || [ -L "$WORKSPACE/node_modules" ]; then
  if [ "$(readlink "$WORKSPACE/node_modules" 2>/dev/null || true)" != "$OPENCODE_RUNTIME_NODE_DEPS" ]; then
    rm -rf "$WORKSPACE/node_modules"
  fi
fi
ln -sfn "$OPENCODE_RUNTIME_NODE_DEPS" "$WORKSPACE/node_modules"

cp "$APP_ROOT/AGENTS.md" "$GLOBAL_OPENCODE_DIR/AGENTS.md"
if [ -f "$APP_ROOT/opencode.json" ]; then
  cp "$APP_ROOT/opencode.json" "$GLOBAL_OPENCODE_DIR/opencode.json"
fi
if [ -d "$APP_ROOT/.opencode/tools" ]; then
  cp -a "$APP_ROOT/.opencode/tools/." "$GLOBAL_TOOLS_DIR/"
fi

REAL_GH_BIN="$(command -v gh 2>/dev/null || true)"
REAL_RAILWAY_BIN="$(command -v railway 2>/dev/null || true)"
export ORBIT_REAL_GH_BIN="$REAL_GH_BIN"
export ORBIT_REAL_RAILWAY_BIN="$REAL_RAILWAY_BIN"

cat > "$INTEGRATION_BIN_DIR/gh" <<'EOF_GH'
#!/bin/sh
set -eu
STATE_FILE="${OPENCODE_TELEGRAM_HOME:-/app/.orbit-state}/app-state.json"
TOKEN=""
ACCOUNT_ID="github"
if [ -f "$STATE_FILE" ]; then
  TOKEN="$(jq -r '(.integrations.github // {}) as $g | (($g.accounts // []) | map(select(.id == $g.activeId)) + ($g.accounts // [])) | .[0].token // empty' "$STATE_FILE" 2>/dev/null || true)"
  ACCOUNT_ID="$(jq -r '(.integrations.github // {}) as $g | (($g.accounts // []) | map(select(.id == $g.activeId)) + ($g.accounts // [])) | .[0].id // "github"' "$STATE_FILE" 2>/dev/null || echo github)"
fi
GH_CONFIG_DIR="${OPENCODE_TELEGRAM_HOME:-/app/.orbit-state}/.config/gh/accounts/$ACCOUNT_ID"
mkdir -p "$GH_CONFIG_DIR"
chmod 700 "$GH_CONFIG_DIR"
export GH_CONFIG_DIR
if [ -n "$TOKEN" ]; then
  export GH_TOKEN="$TOKEN" GITHUB_TOKEN="$TOKEN"
else
  unset GH_TOKEN GITHUB_TOKEN 2>/dev/null || true
fi
[ -n "${ORBIT_REAL_GH_BIN:-}" ] || { echo "gh CLI is unavailable" >&2; exit 127; }
exec "$ORBIT_REAL_GH_BIN" "$@"
EOF_GH

cat > "$INTEGRATION_BIN_DIR/railway" <<'EOF_RW'
#!/bin/sh
set -eu
STATE_FILE="${OPENCODE_TELEGRAM_HOME:-/app/.orbit-state}/app-state.json"
TOKEN=""
TOKEN_TYPE=""
if [ -f "$STATE_FILE" ]; then
  TOKEN_TYPE="$(jq -r '(.integrations.railway // {}) as $r | (($r.accounts // []) | map(select(.id == $r.activeId)) + ($r.accounts // [])) | .[0].tokenType // empty' "$STATE_FILE" 2>/dev/null || true)"
  TOKEN="$(jq -r '(.integrations.railway // {}) as $r | (($r.accounts // []) | map(select(.id == $r.activeId)) + ($r.accounts // [])) | .[0].token // empty' "$STATE_FILE" 2>/dev/null || true)"
fi
if [ -n "$TOKEN" ]; then
  if [ "$TOKEN_TYPE" = "project" ]; then
    export RAILWAY_TOKEN="$TOKEN"
    unset RAILWAY_API_TOKEN 2>/dev/null || true
  else
    export RAILWAY_API_TOKEN="$TOKEN"
    unset RAILWAY_TOKEN 2>/dev/null || true
  fi
else
  unset RAILWAY_TOKEN RAILWAY_API_TOKEN 2>/dev/null || true
fi
[ -n "${ORBIT_REAL_RAILWAY_BIN:-}" ] || { echo "Railway CLI is unavailable" >&2; exit 127; }
exec "$ORBIT_REAL_RAILWAY_BIN" "$@"
EOF_RW
chmod 700 "$INTEGRATION_BIN_DIR/gh" "$INTEGRATION_BIN_DIR/railway"

cat > "$STATE_ROOT/run/github-credential-helper.sh" <<'EOF_CRED'
#!/bin/sh
set -eu
STATE_FILE="${OPENCODE_TELEGRAM_HOME:-/app/.orbit-state}/app-state.json"
TOKEN=""
if [ -f "$STATE_FILE" ]; then
  TOKEN="$(jq -r '(.integrations.github // {}) as $g | (($g.accounts // []) | map(select(.id == $g.activeId)) + ($g.accounts // [])) | .[0].token // empty' "$STATE_FILE" 2>/dev/null || true)"
fi
if [ -n "$TOKEN" ]; then
  printf '%s\n' 'username=x-access-token'
  printf 'password=%s\n' "$TOKEN"
fi
EOF_CRED
chmod 700 "$STATE_ROOT/run/github-credential-helper.sh"

export PATH="$INTEGRATION_BIN_DIR:$PATH"
git config --global credential.https://github.com/.helper "$STATE_ROOT/run/github-credential-helper.sh"
git config --global credential.https://github.com/.useHttpPath false

TOTAL_MB="$(df -Pm "$STATE_ROOT" 2>/dev/null | awk 'NR==2 {print $2}')"
USED_MB="$(df -Pm "$STATE_ROOT" 2>/dev/null | awk 'NR==2 {print $3}')"
FREE_MB="$(df -Pm "$STATE_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
log "Runtime bootstrap starting"
log "App root: $APP_ROOT"
log "State root: $STATE_ROOT"
log "Workspace: $WORKSPACE"
log "Storage: total=${TOTAL_MB:-unknown}MB used=${USED_MB:-unknown}MB free=${FREE_MB:-unknown}MB"
log "OpenCode CLI: $(opencode --version 2>/dev/null || echo unavailable)"
log "Playwright CLI: $(playwright-cli --version 2>/dev/null || echo unavailable)"
GH_VERSION="$(if [ -n "$REAL_GH_BIN" ]; then "$REAL_GH_BIN" --version 2>/dev/null | head -1 || true; fi)"
RAILWAY_VERSION="$(if [ -n "$REAL_RAILWAY_BIN" ]; then "$REAL_RAILWAY_BIN" --version 2>/dev/null | head -1 || true; fi)"
[ -n "$GH_VERSION" ] || GH_VERSION="unavailable"
[ -n "$RAILWAY_VERSION" ] || RAILWAY_VERSION="unavailable"
log "Toolchain: node=$(node --version), python=$(python3 --version 2>/dev/null || echo unavailable), git=$(git --version), gh=$GH_VERSION, railway=$RAILWAY_VERSION"

HEALTH_PORT="${APP_PORT:-}"
case "$HEALTH_PORT" in
  ''|*[!0-9]*) fatal "Orbit APP_PORT is missing or invalid: ${HEALTH_PORT:-unset}" ;;
esac
if [ "$HEALTH_PORT" -lt 1 ] || [ "$HEALTH_PORT" -gt 65535 ]; then
  fatal "Orbit APP_PORT is outside 1-65535: $HEALTH_PORT"
fi
node -e '
const http = require("node:http");
const port = Number(process.argv[1]);
const server = http.createServer((req, res) => {
  if (req.url !== "/" && req.url !== "/health") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ status: "ok", service: "opencode-telegram-bot", platform: "orbit" }));
});
server.listen(port, "0.0.0.0");
' "$HEALTH_PORT" &
log "Health endpoint listening on 0.0.0.0:$HEALTH_PORT"

cd "$WORKSPACE"
log "OpenCode Telegram Bot starting"
exec node "$APP_ROOT/dist/index.js"

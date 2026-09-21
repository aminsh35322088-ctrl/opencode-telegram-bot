#!/bin/sh
set -eu

OPENCODE_API_URL="http://127.0.0.1:4096"
OPENCODE_AUTO_RESTART_ENABLED="true"
OPENCODE_AUTO_START_IN_CONTAINER="true"
OPENCODE_MONITOR_INTERVAL_SEC="20"
OPENCODE_MODEL_PROVIDER="opencode"
OPENCODE_MODEL_ID="big-pickle"
OPEN_BROWSER_ROOTS="/data/workspace"
OPENCODE_CONFIG_DIR="/data/.config/opencode"
OPENCODE_TELEGRAM_WORKSPACE="/data/workspace"
OPENCODE_EXPERIMENTAL_LSP_TOOL="true"
OPENCODE_ENABLE_EXA="1"
PLAYWRIGHT_BROWSERS_PATH="/opt/ms-playwright"
OPENCODE_RUNTIME_NODE_DEPS="/app/node_modules"
OPENCODE_DATA_VOLUME_BUDGET_MB="${OPENCODE_DATA_VOLUME_BUDGET_MB:-500}"
OPENCODE_DATA_VOLUME_WARN_MB="${OPENCODE_DATA_VOLUME_WARN_MB:-150}"
OPENCODE_DATA_VOLUME_CRITICAL_MB="${OPENCODE_DATA_VOLUME_CRITICAL_MB:-100}"

unset GH_TOKEN GITHUB_TOKEN RAILWAY_TOKEN RAILWAY_API_TOKEN 2>/dev/null || true
GH_HOST="${GH_HOST:-github.com}"
GH_PROMPT_DISABLED="1"
export OPENCODE_API_URL OPENCODE_AUTO_RESTART_ENABLED OPENCODE_AUTO_START_IN_CONTAINER
export OPENCODE_MONITOR_INTERVAL_SEC OPENCODE_MODEL_PROVIDER OPENCODE_MODEL_ID OPEN_BROWSER_ROOTS
export OPENCODE_CONFIG_DIR OPENCODE_TELEGRAM_WORKSPACE OPENCODE_EXPERIMENTAL_LSP_TOOL OPENCODE_ENABLE_EXA PLAYWRIGHT_BROWSERS_PATH OPENCODE_RUNTIME_NODE_DEPS
export OPENCODE_DATA_VOLUME_BUDGET_MB OPENCODE_DATA_VOLUME_WARN_MB OPENCODE_DATA_VOLUME_CRITICAL_MB
export GH_HOST GH_PROMPT_DISABLED

GLOBAL_OPENCODE_DIR="/data/.config/opencode"
GLOBAL_TOOLS_DIR="$GLOBAL_OPENCODE_DIR/tools"
INTEGRATION_STATE_FILE="${OPENCODE_TELEGRAM_HOME:-/data}/app-state.json"
INTEGRATION_BIN_DIR="/data/run/integration-bin"
GH_ACCOUNTS_DIR="/data/.config/gh/accounts"
RUSTDESK_BRIDGE_LOCK="/app/rustdesk-bridge.lock"
RUSTDESK_BRIDGE_BIN_DIR="/data/bin"
RUSTDESK_BRIDGE_BINARY="/data/bin/rustdesk-controller-bridge"
RUSTDESK_BRIDGE_DOWNLOAD_DIR="/data/run/rustdesk-bridge-download"
RUSTDESK_STATE_DIR="/data/rustdesk"
RUSTDESK_CONFIG_FILE="/data/rustdesk/config.json"
RUSTDESK_IDENTITY_DIR="/data/rustdesk/identity"
RUSTDESK_AUDIT_DIR="/data/rustdesk/audit"
RUSTDESK_AUDIT_FILE="/data/rustdesk/audit/audit.jsonl"
RUSTDESK_LOG_FILE="/data/logs/rustdesk-bridge.log"
mkdir -p /data/logs /data/run /data/.config /data/.local/share /data/.cache /data/opencode /data/workspace "$GLOBAL_TOOLS_DIR" "$INTEGRATION_BIN_DIR" "$GH_ACCOUNTS_DIR"

rm -rf /data/.cache/npm /data/.npm /data/.cache/tsx /data/.cache/opencode

DATA_FREE_KB="$(df -Pk /data | awk 'NR==2 {print $4}')"
DATA_USED_KB="$(df -Pk /data | awk 'NR==2 {print $3}')"
DATA_TOTAL_KB="$(df -Pk /data | awk 'NR==2 {print $2}')"
DATA_FREE_MB="$((DATA_FREE_KB / 1024))"
DATA_USED_MB="$((DATA_USED_KB / 1024))"
DATA_TOTAL_MB="$((DATA_TOTAL_KB / 1024))"
printf '%s\n' "[railway] Persistent volume: total=${DATA_TOTAL_MB}MB used=${DATA_USED_MB}MB free=${DATA_FREE_MB}MB budget=${OPENCODE_DATA_VOLUME_BUDGET_MB}MB warn=${OPENCODE_DATA_VOLUME_WARN_MB}MB critical=${OPENCODE_DATA_VOLUME_CRITICAL_MB}MB"
if [ "$DATA_FREE_MB" -lt "$OPENCODE_DATA_VOLUME_CRITICAL_MB" ]; then
  printf '%s\n' "[railway] WARNING: /data is below the critical free-space threshold"
elif [ "$DATA_FREE_MB" -lt "$OPENCODE_DATA_VOLUME_WARN_MB" ]; then
  printf '%s\n' "[railway] WARNING: /data is below the warning free-space threshold"
fi

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

# Keep a single generated dependency tree in the workspace and point it at the
# production dependency tree baked into the image. This avoids stale dependencies
# persisting on the Railway volume across deploys.
if [ -e /data/workspace/node_modules ] || [ -L /data/workspace/node_modules ]; then
  if [ "$(readlink /data/workspace/node_modules 2>/dev/null || true)" != "$OPENCODE_RUNTIME_NODE_DEPS" ]; then
    printf '%s\n' "[railway] Removing workspace-local node_modules; using runtime dependencies from ${OPENCODE_RUNTIME_NODE_DEPS}"
    rm -rf /data/workspace/node_modules
  fi
fi
if [ ! -d "$OPENCODE_RUNTIME_NODE_DEPS" ]; then
  printf '%s\n' "[railway] FATAL: runtime dependency tree is missing: ${OPENCODE_RUNTIME_NODE_DEPS}" >&2
  exit 1
fi
ln -sfn "$OPENCODE_RUNTIME_NODE_DEPS" /data/workspace/node_modules

if [ -d /app/.opencode/tools ]; then
  # Mirror the baked tools; a merge copy would leave tools removed or renamed
  # in the repo active forever as stale global definitions.
  find "$GLOBAL_TOOLS_DIR" -maxdepth 1 -name "*.ts" -type f -delete
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

bootstrap_rustdesk_bridge() {
  if [ ! -r "$RUSTDESK_BRIDGE_LOCK" ]; then
    printf '%s\n' "[railway] WARNING: RustDesk bridge lock file is missing; RustDesk integration is disabled" >&2
    return 1
  fi

  # This file is image-owned and contains only immutable release metadata.
  # shellcheck disable=SC1090
  . "$RUSTDESK_BRIDGE_LOCK"

  if [ -z "${RUSTDESK_BRIDGE_REPOSITORY:-}" ] || \
     [ -z "${RUSTDESK_BRIDGE_RELEASE_TAG:-}" ] || \
     [ -z "${RUSTDESK_BRIDGE_CORE_COMMIT:-}" ] || \
     [ -z "${RUSTDESK_BRIDGE_ASSET:-}" ] || \
     [ -z "${RUSTDESK_BRIDGE_SHA256:-}" ] || \
     [ -z "${RUSTDESK_BRIDGE_CONTRACT_VERSION:-}" ]; then
    printf '%s\n' "[railway] WARNING: RustDesk bridge lock metadata is incomplete; RustDesk integration is disabled" >&2
    return 1
  fi

  mkdir -p "$RUSTDESK_BRIDGE_BIN_DIR" "$RUSTDESK_STATE_DIR" "$RUSTDESK_IDENTITY_DIR" "$RUSTDESK_AUDIT_DIR"
  chown -R node:node "$RUSTDESK_BRIDGE_BIN_DIR" "$RUSTDESK_STATE_DIR"
  chmod 700 "$RUSTDESK_STATE_DIR" "$RUSTDESK_IDENTITY_DIR" "$RUSTDESK_AUDIT_DIR"

  if [ ! -f "$RUSTDESK_CONFIG_FILE" ]; then
    printf '%s\n' '{"serverProfiles":[],"devices":[]}' > "$RUSTDESK_CONFIG_FILE"
    chown node:node "$RUSTDESK_CONFIG_FILE"
    chmod 600 "$RUSTDESK_CONFIG_FILE"
  fi

  if [ -x "$RUSTDESK_BRIDGE_BINARY" ]; then
    if printf '%s  %s\n' "$RUSTDESK_BRIDGE_SHA256" "$RUSTDESK_BRIDGE_BINARY" | sha256sum -c - >/dev/null 2>&1; then
      printf '%s\n' "[railway] RustDesk bridge artifact cache verified (${RUSTDESK_BRIDGE_CORE_COMMIT})"
      return 0
    fi
    printf '%s\n' "[railway] WARNING: cached RustDesk bridge checksum mismatch; removing it" >&2
    rm -f "$RUSTDESK_BRIDGE_BINARY"
  fi

  rm -rf "$RUSTDESK_BRIDGE_DOWNLOAD_DIR"
  mkdir -p "$RUSTDESK_BRIDGE_DOWNLOAD_DIR"
  chown node:node "$RUSTDESK_BRIDGE_DOWNLOAD_DIR"

  if ! su -s /bin/sh node -c "/data/run/integration-bin/gh release download '$RUSTDESK_BRIDGE_RELEASE_TAG' --repo '$RUSTDESK_BRIDGE_REPOSITORY' --pattern '$RUSTDESK_BRIDGE_ASSET' --dir '$RUSTDESK_BRIDGE_DOWNLOAD_DIR'"; then
    printf '%s\n' "[railway] WARNING: RustDesk bridge artifact download failed; connect the GitHub integration and restart to enable RustDesk" >&2
    rm -rf "$RUSTDESK_BRIDGE_DOWNLOAD_DIR"
    return 1
  fi

  RUSTDESK_DOWNLOADED_BINARY="$RUSTDESK_BRIDGE_DOWNLOAD_DIR/$RUSTDESK_BRIDGE_ASSET"
  if [ ! -f "$RUSTDESK_DOWNLOADED_BINARY" ] || \
     ! printf '%s  %s\n' "$RUSTDESK_BRIDGE_SHA256" "$RUSTDESK_DOWNLOADED_BINARY" | sha256sum -c - >/dev/null 2>&1; then
    printf '%s\n' "[railway] WARNING: RustDesk bridge artifact checksum verification failed" >&2
    rm -rf "$RUSTDESK_BRIDGE_DOWNLOAD_DIR"
    return 1
  fi

  install -m 0755 -o node -g node "$RUSTDESK_DOWNLOADED_BINARY" "$RUSTDESK_BRIDGE_BINARY"
  rm -rf "$RUSTDESK_BRIDGE_DOWNLOAD_DIR"
  printf '%s\n' "[railway] RustDesk bridge artifact verified (${RUSTDESK_BRIDGE_CORE_COMMIT})"
  return 0
}

start_rustdesk_bridge() {
  if ! bootstrap_rustdesk_bridge; then
    unset RUSTDESK_BRIDGE_URL RUSTDESK_BRIDGE_TOKEN RUSTDESK_BRIDGE_CONTROL_TOKEN 2>/dev/null || true
    return 0
  fi

  RUSTDESK_BRIDGE_URL=http://127.0.0.1:21119
  RUSTDESK_BRIDGE_BIND=127.0.0.1:21119
  RUSTDESK_BRIDGE_CONFIG_FILE="$RUSTDESK_CONFIG_FILE"
  RUSTDESK_BRIDGE_IDENTITY_DIR="$RUSTDESK_IDENTITY_DIR"
  RUSTDESK_BRIDGE_AUDIT_FILE="$RUSTDESK_AUDIT_FILE"
  RUSTDESK_BRIDGE_TOKEN="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
  RUSTDESK_BRIDGE_CONTROL_TOKEN="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
  export RUSTDESK_BRIDGE_URL RUSTDESK_BRIDGE_BIND RUSTDESK_BRIDGE_CONFIG_FILE
  export RUSTDESK_BRIDGE_IDENTITY_DIR RUSTDESK_BRIDGE_AUDIT_FILE
  export RUSTDESK_BRIDGE_TOKEN RUSTDESK_BRIDGE_CONTROL_TOKEN

  : > "$RUSTDESK_LOG_FILE"
  chown node:node "$RUSTDESK_LOG_FILE"
  chmod 600 "$RUSTDESK_LOG_FILE"

  su -s /bin/sh node -c "exec '$RUSTDESK_BRIDGE_BINARY'" >>"$RUSTDESK_LOG_FILE" 2>&1 &
  RUSTDESK_BRIDGE_PID=$!

  RUSTDESK_READY=0
  RUSTDESK_ATTEMPT=0
  while [ "$RUSTDESK_ATTEMPT" -lt 50 ]; do
    if ! kill -0 "$RUSTDESK_BRIDGE_PID" 2>/dev/null; then
      break
    fi
    if curl -fsS -H "Authorization: Bearer $RUSTDESK_BRIDGE_TOKEN" "$RUSTDESK_BRIDGE_URL/health" \
      | jq -e ".ok == true and .service == \"rustdesk-controller-bridge\" and .contractVersion == $RUSTDESK_BRIDGE_CONTRACT_VERSION" >/dev/null 2>&1; then
      RUSTDESK_READY=1
      break
    fi
    RUSTDESK_ATTEMPT=$((RUSTDESK_ATTEMPT + 1))
    sleep 0.1
  done

  if [ "$RUSTDESK_READY" -ne 1 ]; then
    printf '%s\n' "[railway] WARNING: RustDesk bridge failed readiness; RustDesk integration is disabled" >&2
    kill "$RUSTDESK_BRIDGE_PID" 2>/dev/null || true
    wait "$RUSTDESK_BRIDGE_PID" 2>/dev/null || true
    unset RUSTDESK_BRIDGE_URL RUSTDESK_BRIDGE_BIND RUSTDESK_BRIDGE_CONFIG_FILE
    unset RUSTDESK_BRIDGE_IDENTITY_DIR RUSTDESK_BRIDGE_AUDIT_FILE
    unset RUSTDESK_BRIDGE_TOKEN RUSTDESK_BRIDGE_CONTROL_TOKEN
    return 0
  fi

  printf '%s\n' "[railway] RustDesk bridge ready: loopback contract v${RUSTDESK_BRIDGE_CONTRACT_VERSION}, pid=${RUSTDESK_BRIDGE_PID}"
}

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

start_rustdesk_bridge

printf '%s\n' "[railway] OpenCode Telegram Bot starting"
printf '%s\n' "[railway] OpenCode CLI: $(su -s /bin/sh node -c 'opencode --version' 2>/dev/null || echo unknown)"
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
printf '%s\n' "[railway] Runtime dependencies: ${OPENCODE_RUNTIME_NODE_DEPS}"
printf '%s\n' "[railway] GitHub/Railway integrations: credentials loaded dynamically from persistent bot state"

# Version probes above run as root and may create root-owned cache dirs (e.g. opencode --version
# writes /data/.cache/opencode). The bot runs as node, so restore ownership before startup.
chown -R node:node /data/.cache /data/.local 2>/dev/null || true

export PATH="$INTEGRATION_BIN_DIR:$PATH"
cd "$OPENCODE_TELEGRAM_WORKSPACE"
exec su -s /bin/sh node -c 'export PATH="/data/run/integration-bin:$PATH"; cd "$OPENCODE_TELEGRAM_WORKSPACE" && exec node /app/dist/index.js'

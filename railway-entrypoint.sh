#!/bin/sh
set -eu

: "${OPENCODE_API_URL:=http://127.0.0.1:4096}"
: "${OPENCODE_AUTO_RESTART_ENABLED:=true}"
: "${OPENCODE_AUTO_START_IN_CONTAINER:=true}"
: "${OPENCODE_MONITOR_INTERVAL_SEC:=60}"
: "${OPENCODE_MODEL_PROVIDER:=opencode}"
: "${OPENCODE_MODEL_ID:=big-pickle}"
: "${OPEN_BROWSER_ROOTS:=/data/workspace}"
: "${OPENCODE_CONFIG_DIR:=/data/.config/opencode}"
: "${OPENCODE_EXPERIMENTAL_LSP_TOOL:=true}"
: "${OPENCODE_ENABLE_EXA:=1}"
: "${PLAYWRIGHT_BROWSERS_PATH:=/opt/ms-playwright}"

export OPENCODE_API_URL OPENCODE_AUTO_RESTART_ENABLED OPENCODE_AUTO_START_IN_CONTAINER
export OPENCODE_MONITOR_INTERVAL_SEC OPENCODE_MODEL_PROVIDER OPENCODE_MODEL_ID OPEN_BROWSER_ROOTS
export OPENCODE_CONFIG_DIR OPENCODE_EXPERIMENTAL_LSP_TOOL OPENCODE_ENABLE_EXA PLAYWRIGHT_BROWSERS_PATH

# OpenCode's global config/tool location for HOME=/data + XDG_CONFIG_HOME=/data/.config.
GLOBAL_OPENCODE_DIR="${XDG_CONFIG_HOME:-/data/.config}/opencode"
GLOBAL_TOOLS_DIR="$GLOBAL_OPENCODE_DIR/tools"
mkdir -p /data/logs /data/run /data/.config /data/.local/share /data/.cache /data/opencode /data/workspace "$GLOBAL_TOOLS_DIR"

# Keep the historical /app/workspace path as a compatibility alias. Existing
# persisted sessions may still reference it, while all actual workspace data
# now lives on the Railway Volume under /data/workspace.
if [ -e /app/workspace ] && [ ! -L /app/workspace ]; then
  if [ -d /app/workspace ] && [ "$(find /app/workspace -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    printf '%s\n' "[railway] Migrating image-local workspace contents to persistent volume"
    cp -a /app/workspace/. /data/workspace/
  fi
  rm -rf /app/workspace
fi
ln -sfn /data/workspace /app/workspace

# Some OpenCode agents may choose the historical /tmp/site path when creating
# web projects. That path is ephemeral on Railway, so transparently alias it
# to the same persistent shared workspace. Existing files are migrated first.
if [ -e /tmp/site ] && [ ! -L /tmp/site ]; then
  if [ -d /tmp/site ] && [ "$(find /tmp/site -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    printf '%s\n' "[railway] Migrating legacy /tmp/site contents to persistent workspace"
    cp -a /tmp/site/. /data/workspace/
  fi
  rm -rf /tmp/site
fi
ln -sfn /data/workspace /tmp/site

# Persist the complete custom-tool bundle where OpenCode actually discovers
# global tools. This also works when a session's project directory is /data/workspace.
if [ -d /app/.opencode/tools ]; then
  cp -a /app/.opencode/tools/. "$GLOBAL_TOOLS_DIR/"
  chown -R node:node "$GLOBAL_TOOLS_DIR"
fi

# Make the project permission config available globally as well as at /app so
# tool access does not depend on the OpenCode server's working directory.
if [ -f /app/opencode.json ]; then
  cp /app/opencode.json "$GLOBAL_OPENCODE_DIR/opencode.json"
  chown node:node "$GLOBAL_OPENCODE_DIR/opencode.json"
fi

chown -R node:node /data

GITHUB_TOKEN_FILE="/data/integrations/github.token"
if [ -s "$GITHUB_TOKEN_FILE" ]; then
  GITHUB_TOKEN="$(cat "$GITHUB_TOKEN_FILE")"
  export GITHUB_TOKEN
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  mkdir -p "$(dirname "$GITHUB_TOKEN_FILE")"
  printf '%s\n' "$GITHUB_TOKEN" > "$GITHUB_TOKEN_FILE"
  chmod 600 "$GITHUB_TOKEN_FILE"
  chown node:node "$GITHUB_TOKEN_FILE"
fi

cat > /data/run/github-credential-helper.sh <<'EOF'
#!/bin/sh
set -eu

host=""
while IFS= read -r line; do
  case "$line" in
    host=*) host=${line#host=} ;;
  esac
done

TOKEN_FILE="/data/integrations/github.token"
if [ "$host" = "github.com" ] && [ -s "$TOKEN_FILE" ]; then
  printf '%s\n' 'username=x-access-token'
  printf 'password=%s\n' "$(cat "$TOKEN_FILE")"
fi
EOF
chmod 700 /data/run/github-credential-helper.sh
chown node:node /data/run/github-credential-helper.sh

su -s /bin/sh node -c 'git config --global credential.https://github.com/.helper /data/run/github-credential-helper.sh'
su -s /bin/sh node -c 'git config --global credential.https://github.com/.useHttpPath false'

if [ -s "$GITHUB_TOKEN_FILE" ]; then
  printf '%s\n' "[railway] GitHub integration: configured"
else
  printf '%s\n' "[railway] GitHub integration: not configured"
fi

printf '%s\n' "[railway] OpenCode Telegram Bot starting"
printf '%s\n' "[railway] OpenCode CLI: $(opencode --version 2>/dev/null || echo unknown)"
printf '%s\n' "[railway] OpenCode API: ${OPENCODE_API_URL}"
printf '%s\n' "[railway] Auto-start: ${OPENCODE_AUTO_START_IN_CONTAINER}"
printf '%s\n' "[railway] Workspace: ${OPEN_BROWSER_ROOTS}"
printf '%s\n' "[railway] Persistent shared workspace: /data/workspace"
printf '%s\n' "[railway] Legacy /app/workspace -> /data/workspace"
printf '%s\n' "[railway] Legacy /tmp/site -> /data/workspace"
printf '%s\n' "[railway] OpenCode config dir: ${OPENCODE_CONFIG_DIR}"
printf '%s\n' "[railway] Global tool dir: ${GLOBAL_TOOLS_DIR}"
printf '%s\n' "[railway] Agent tools: $(find "$GLOBAL_TOOLS_DIR" -maxdepth 1 -name '*.ts' -type f 2>/dev/null | wc -l) custom tools"
printf '%s\n' "[railway] Playwright CLI: $(playwright-cli --version 2>/dev/null || echo unavailable)"
printf '%s\n' "[railway] Toolchain: node=$(node --version), python=$(python3 --version 2>/dev/null || echo unavailable), git=$(git --version), zip=$(zip -v 2>/dev/null | head -1 || echo unavailable), sqlite=$(sqlite3 --version 2>/dev/null | head -1 || echo unavailable), rg=$(rg --version 2>/dev/null | head -1 || echo unavailable)"

exec su -s /bin/sh node -c 'exec node /app/dist/index.js'

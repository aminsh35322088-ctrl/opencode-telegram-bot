#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${DAYTONA_APP_DIR:-/home/daytona/app}"
LOCAL_HOME="${DAYTONA_LOCAL_HOME:-/home/daytona}"
STATE_DIR="${OPENCODE_TELEGRAM_HOME:-/data/opencode-telegram-bot}"
RUNTIME_DIR="${DAYTONA_RUNTIME_DIR:-${LOCAL_HOME}/.run/opencode-telegram-bot}"
LOG_DIR="${DAYTONA_LOG_DIR:-${LOCAL_HOME}/.logs/opencode-telegram-bot}"
TOOL_PREFIX="${DAYTONA_TOOL_PREFIX:-${LOCAL_HOME}/.npm-global}"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "[daytona] FATAL: Git checkout not found at ${APP_DIR}" >&2
  exit 1
fi
if [[ ! -f "${APP_DIR}/dist/index.js" ]]; then
  echo "[daytona] FATAL: ${APP_DIR}/dist/index.js is missing; run daytona-redeploy.sh first" >&2
  exit 1
fi
if [[ ! -d "${APP_DIR}/node_modules" ]]; then
  echo "[daytona] FATAL: ${APP_DIR}/node_modules is missing; run daytona-redeploy.sh first" >&2
  exit 1
fi
if [[ ! -d /data ]]; then
  echo "[daytona] FATAL: /data is missing. Mount the Daytona Volume at /data." >&2
  exit 1
fi

mkdir -p "${STATE_DIR}" "${RUNTIME_DIR}" "${LOG_DIR}" \
  "${LOCAL_HOME}/.config" "${LOCAL_HOME}/.local/share" "${LOCAL_HOME}/.cache" "${TOOL_PREFIX}"

export NODE_ENV="${NODE_ENV:-production}"
export HOME="${LOCAL_HOME}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${LOCAL_HOME}/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${LOCAL_HOME}/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${LOCAL_HOME}/.cache}"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-${TOOL_PREFIX}}"
export PATH="${TOOL_PREFIX}/bin:${PATH}"

# Keep bot-owned durable state on the mounted Daytona Volume, while high-churn
# logs and PID/runtime files stay on Daytona's local sandbox disk.
export OPENCODE_TELEGRAM_HOME="${STATE_DIR}"
export OPENCODE_TELEGRAM_LOGS_DIR="${OPENCODE_TELEGRAM_LOGS_DIR:-${LOG_DIR}/bot}"
export OPENCODE_TELEGRAM_RUN_DIR="${OPENCODE_TELEGRAM_RUN_DIR:-${RUNTIME_DIR}/bot}"
export OPENCODE_TELEGRAM_WORKSPACE="${OPENCODE_TELEGRAM_WORKSPACE:-${APP_DIR}}"
export OPEN_BROWSER_ROOTS="${OPEN_BROWSER_ROOTS:-${APP_DIR}}"
export OPENCODE_API_URL="${OPENCODE_API_URL:-http://127.0.0.1:4096}"
export OPENCODE_AUTO_RESTART_ENABLED="${OPENCODE_AUTO_RESTART_ENABLED:-true}"
export OPENCODE_AUTO_START_IN_CONTAINER="${OPENCODE_AUTO_START_IN_CONTAINER:-true}"
export OPENCODE_TELEGRAM_CONTAINER="${OPENCODE_TELEGRAM_CONTAINER:-true}"
export OPENCODE_MONITOR_INTERVAL_SEC="${OPENCODE_MONITOR_INTERVAL_SEC:-20}"
export OPENCODE_MODEL_PROVIDER="${OPENCODE_MODEL_PROVIDER:-opencode}"
export OPENCODE_MODEL_ID="${OPENCODE_MODEL_ID:-big-pickle}"
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${LOCAL_HOME}/.config/opencode}"
export OPENCODE_HOME="${OPENCODE_HOME:-${LOCAL_HOME}/.opencode}"
export OPENCODE_EXPERIMENTAL_LSP_TOOL="${OPENCODE_EXPERIMENTAL_LSP_TOOL:-true}"
export OPENCODE_ENABLE_EXA="${OPENCODE_ENABLE_EXA:-1}"
export OPENCODE_RUNTIME_NODE_DEPS="${OPENCODE_RUNTIME_NODE_DEPS:-${APP_DIR}/node_modules}"
export OPENCODE_LOG_DIR="${OPENCODE_LOG_DIR:-${LOG_DIR}/opencode}"

mkdir -p "${OPENCODE_TELEGRAM_LOGS_DIR}" "${OPENCODE_TELEGRAM_RUN_DIR}" "${OPENCODE_LOG_DIR}"

# Patch only the Node process running on Daytona. Railway never sets this import,
# so its native POSIX volume behavior stays unchanged.
DAYTONA_NODE_IMPORT="--import=${APP_DIR}/daytona-fs-compat.mjs"
case " ${NODE_OPTIONS:-} " in
  *" ${DAYTONA_NODE_IMPORT} "*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }${DAYTONA_NODE_IMPORT}" ;;
esac

if ! command -v opencode >/dev/null 2>&1; then
  echo "[daytona] FATAL: OpenCode CLI is missing; run daytona-redeploy.sh first" >&2
  exit 1
fi

if [[ ! -f "${STATE_DIR}/.env" ]] && { [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] || [[ -z "${TELEGRAM_ALLOWED_USER_ID:-}" ]]; }; then
  echo "[daytona] FATAL: bot credentials are missing." >&2
  echo "[daytona] Create ${STATE_DIR}/.env or provide TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID." >&2
  exit 1
fi

cd "${APP_DIR}"
echo "[daytona] Starting OpenCode Telegram Bot"
echo "[daytona] App: ${APP_DIR}"
echo "[daytona] Persistent state: ${STATE_DIR}"
echo "[daytona] Local bot logs: ${OPENCODE_TELEGRAM_LOGS_DIR}"
echo "[daytona] Development workspace: ${OPENCODE_TELEGRAM_WORKSPACE}"
echo "[daytona] OpenCode CLI: $(opencode --version 2>/dev/null || echo unknown)"
exec node "${APP_DIR}/dist/index.js"

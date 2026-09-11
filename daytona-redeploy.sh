#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${DAYTONA_APP_DIR:-/home/daytona/app}"
LOCAL_HOME="${DAYTONA_LOCAL_HOME:-/home/daytona}"
STATE_DIR="${OPENCODE_TELEGRAM_HOME:-/data/opencode-telegram-bot}"
RUN_DIR="${DAYTONA_RUNTIME_DIR:-${LOCAL_HOME}/.run/opencode-telegram-bot}"
LOG_DIR="${DAYTONA_LOG_DIR:-${LOCAL_HOME}/.logs/opencode-telegram-bot}"
TOOL_PREFIX="${DAYTONA_TOOL_PREFIX:-${LOCAL_HOME}/.npm-global}"
BRANCH="${DAYTONA_GIT_BRANCH:-main}"
PID_FILE="${RUN_DIR}/bot.pid"
LOG_FILE="${LOG_DIR}/launcher.log"
LOCK_DIR="${RUN_DIR}/redeploy.lock"

mkdir -p "${RUN_DIR}" "${LOG_DIR}" "${STATE_DIR}" "${TOOL_PREFIX}"

# Git can replace this script while fast-forwarding the checkout. Re-execute a
# stable local copy first so the running deployment logic cannot change mid-run.
if [[ "${DAYTONA_REDEPLOY_STABLE_COPY:-0}" != "1" ]]; then
  STABLE_SCRIPT="${RUN_DIR}/redeploy-exec.sh"
  cp "$0" "${STABLE_SCRIPT}"
  chmod 700 "${STABLE_SCRIPT}"
  exec env DAYTONA_REDEPLOY_STABLE_COPY=1 "${STABLE_SCRIPT}" "$@"
fi

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "[daytona] Another redeploy is already running: ${LOCK_DIR}" >&2
  exit 1
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "[daytona] FATAL: Git checkout not found at ${APP_DIR}" >&2
  exit 1
fi

cd "${APP_DIR}"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "${CURRENT_BRANCH}" != "${BRANCH}" ]]; then
  echo "[daytona] FATAL: checkout is on '${CURRENT_BRANCH}', expected '${BRANCH}'." >&2
  echo "[daytona] Set DAYTONA_GIT_BRANCH=${CURRENT_BRANCH} if this is intentional." >&2
  exit 2
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[daytona] FATAL: working tree has uncommitted changes; redeploy will not overwrite development work." >&2
  git status --short
  exit 2
fi

echo "[daytona] Fetching origin/${BRANCH}"
git fetch --prune origin "${BRANCH}"

REMOTE_REF="origin/${BRANCH}"
if git merge-base --is-ancestor HEAD "${REMOTE_REF}"; then
  git merge --ff-only "${REMOTE_REF}"
elif git merge-base --is-ancestor "${REMOTE_REF}" HEAD; then
  echo "[daytona] Local branch is ahead of ${REMOTE_REF}; keeping local commits."
else
  echo "[daytona] FATAL: local and remote branches diverged. Resolve Git history before redeploy." >&2
  exit 2
fi

echo "[daytona] Installing exact npm dependencies"
npm ci

echo "[daytona] Building TypeScript"
npm run build

if [[ "${DAYTONA_RUN_LINT:-0}" == "1" ]]; then
  echo "[daytona] Running lint"
  npm run lint
fi

export NPM_CONFIG_PREFIX="${TOOL_PREFIX}"
export PATH="${TOOL_PREFIX}/bin:${PATH}"

if [[ ! -f .opencode-version ]]; then
  echo "[daytona] FATAL: .opencode-version is missing" >&2
  exit 1
fi
OPENCODE_VERSION="$(tr -d '\r\n' < .opencode-version)"
if [[ -z "${OPENCODE_VERSION}" ]]; then
  echo "[daytona] FATAL: .opencode-version is empty" >&2
  exit 1
fi

INSTALLED_OPENCODE_VERSION="$(opencode --version 2>/dev/null || true)"
if [[ "${INSTALLED_OPENCODE_VERSION}" != "${OPENCODE_VERSION}" ]]; then
  echo "[daytona] Installing OpenCode CLI ${OPENCODE_VERSION} into ${TOOL_PREFIX}"
  npm install -g --prefix "${TOOL_PREFIX}" "opencode-ai@${OPENCODE_VERSION}"
fi

stop_existing_bot() {
  [[ -f "${PID_FILE}" ]] || return 0

  local pid
  pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ ! "${pid}" =~ ^[0-9]+$ ]] || ! kill -0 "${pid}" 2>/dev/null; then
    rm -f "${PID_FILE}"
    return 0
  fi

  echo "[daytona] Stopping bot pid=${pid}"
  kill -TERM "${pid}" 2>/dev/null || true
  for _ in {1..50}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${PID_FILE}"
      return 0
    fi
    sleep 0.2
  done

  echo "[daytona] Bot did not exit in time; sending SIGKILL"
  kill -KILL "${pid}" 2>/dev/null || true
  rm -f "${PID_FILE}"
}

stop_existing_bot

if [[ ! -f "${STATE_DIR}/.env" ]] && { [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] || [[ -z "${TELEGRAM_ALLOWED_USER_ID:-}" ]]; }; then
  echo "[daytona] Build completed, but the bot was not started because credentials are missing." >&2
  echo "[daytona] Create ${STATE_DIR}/.env, then run this redeploy command again." >&2
  exit 3
fi

chmod +x "${APP_DIR}/daytona-start.sh" "${APP_DIR}/daytona-redeploy.sh"
: > "${LOG_FILE}"

echo "[daytona] Starting detached bot process"
if command -v setsid >/dev/null 2>&1; then
  nohup setsid "${APP_DIR}/daytona-start.sh" >>"${LOG_FILE}" 2>&1 </dev/null &
else
  nohup "${APP_DIR}/daytona-start.sh" >>"${LOG_FILE}" 2>&1 </dev/null &
fi
BOT_PID=$!
printf '%s\n' "${BOT_PID}" > "${PID_FILE}"

sleep 6
if ! kill -0 "${BOT_PID}" 2>/dev/null; then
  echo "[daytona] FATAL: bot exited during startup. Recent launcher log:" >&2
  tail -n 80 "${LOG_FILE}" >&2 || true
  rm -f "${PID_FILE}"
  exit 1
fi

echo "[daytona] Redeploy successful: commit=$(git rev-parse --short HEAD) pid=${BOT_PID}"
echo "[daytona] Launcher log: ${LOG_FILE}"
tail -n 20 "${LOG_FILE}" || true

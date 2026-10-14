#!/usr/bin/env bash
# Soak orchestrator: brings up the real Bot against local stubs and runs a stage.
#
# Usage: run.sh [smoke|cycle|stress|soak] [duration-seconds]
#
# SOAK_ACTIVE_S / SOAK_IDLE_S set the RC soak's phase plan in seconds
# (stage=soak requires both > 0; other stages default to continuous).
#
# Everything this script produces lands in one run directory, so a run can be
# inspected or pushed to durable storage afterwards.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOAK="$ROOT/scripts/soak"
STAGE="${1:-smoke}"
DURATION="${2:-0}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${SOAK_RUN_DIR:-$ROOT/soak-runs/$STAMP-$STAGE}"
TELEGRAM_PORT="${SOAK_TELEGRAM_PORT:-8081}"
MODEL_PORT="${SOAK_MODEL_PORT:-8090}"
SOAK_USER_ID="${SOAK_USER_ID:-987654321}"
SOAK_TOKEN="${SOAK_TOKEN:-123:soak}"
# OPENCODE_TELEGRAM_HOME must NOT live inside the repository. The Bot refuses to
# create a topic workspace under its source root and throws
# "Refusing to create topic workspace inside source root"
# (src/app/services/telegram-topic-workspace-service.ts), which silently failed
# session creation on the first smoke run. The run directory stays in the repo so
# evidence collection (and the CI artifact path) keeps working.
SOAK_HOME="${SOAK_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-telegram-soak/$STAMP-$STAGE}"

mkdir -p "$RUN_DIR/evidence"
UPDATES="$RUN_DIR/updates.jsonl"
: > "$UPDATES"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# The Bot spawns `opencode serve` detached, so it is re-parented to init and
# survives Bot shutdown. The next run then sees the port already bound, skips
# spawning, and attaches to that stale server - which still points at the
# previous run's model stub. Every prompt is silently turned into an empty
# reply, so a flow that only counts Telegram messages looks like a pass. Free
# the port before booting.
OPENCODE_PORT="${SOAK_OPENCODE_PORT:-4096}"
for stale in $(pgrep -f "opencode serve --port $OPENCODE_PORT" || true); do
  log "killing stale OpenCode server pid=$stale (bound for a previous run)"
  kill "$stale" 2>/dev/null
done
sleep 1
if pgrep -f "opencode serve --port $OPENCODE_PORT" >/dev/null 2>&1; then
  log "ERROR: port $OPENCODE_PORT is still held after cleanup"
  exit 1
fi

PIDS=()
cleanup() {
  local code=$?
  log "shutting down"
  # Stop the Bot BEFORE the stubs. Killing the stubs first aborts grammy's
  # in-flight long poll with `HttpError: Network request for 'getUpdates'
  # failed!`, which crashes the Bot and turns a clean shutdown into a noisy
  # non-zero exit that can mask the real stage result.
  if [ -n "${BOT_PID:-}" ]; then
    kill "$BOT_PID" 2>/dev/null
    for _ in $(seq 1 15); do
      kill -0 "$BOT_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$BOT_PID" 2>/dev/null
  fi
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  sleep 2
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
  done
  log "run directory: $RUN_DIR"
  exit "$code"
}
trap cleanup EXIT INT TERM

wait_for_health() {
  local url="$1" name="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      log "$name healthy"
      return 0
    fi
    sleep 0.5
  done
  log "ERROR: $name never became healthy ($url)"
  return 1
}

log "run dir: $RUN_DIR"

# --- stub model -------------------------------------------------------------
# A default-speed model finishes a turn in ~0.5 s, so the Bot never has to show
# a streaming draft placeholder - and without a draft there is nothing for
# Telegram's Stop to be attributed to, which made W5 permanently
# not-executable. Slow the stream to a realistic interactive pace and make the
# model emit a tool call often enough for the tool-execution requirement.
MODEL_TOKENS="${SOAK_MODEL_TOKENS:-600}"
MODEL_DELAY_MS="${SOAK_MODEL_DELAY_MS:-150}"
MODEL_TOOL_PROB="${SOAK_MODEL_TOOL_PROB:-0.34}"
log "model stub: tokens=$MODEL_TOKENS delayMs=$MODEL_DELAY_MS toolProb=$MODEL_TOOL_PROB"
node "$SOAK/stub-model.mjs" --port "$MODEL_PORT" --log "$RUN_DIR/model-api.jsonl" \
  --tokens "$MODEL_TOKENS" --delay-ms "$MODEL_DELAY_MS" --tool-prob "$MODEL_TOOL_PROB" \
  >"$RUN_DIR/stub-model.out" 2>&1 &
PIDS+=($!)
wait_for_health "http://127.0.0.1:$MODEL_PORT/health" "model stub" || exit 1

# --- stub Telegram Bot API --------------------------------------------------
node "$SOAK/stub-telegram-api.mjs" --port "$TELEGRAM_PORT" --token "$SOAK_TOKEN" \
  --updates "$UPDATES" --log "$RUN_DIR/telegram-api.jsonl" \
  >"$RUN_DIR/stub-telegram.out" 2>&1 &
PIDS+=($!)
wait_for_health "http://127.0.0.1:$TELEGRAM_PORT/bot$SOAK_TOKEN/getMe" "telegram stub" || exit 1

# --- build the Bot once -----------------------------------------------------
if [ ! -f "$ROOT/dist/index.js" ]; then
  log "building bot"
  npm --prefix "$ROOT" run build >"$RUN_DIR/build.log" 2>&1 || {
    log "ERROR: build failed, see $RUN_DIR/build.log"
    exit 1
  }
fi

# --- start the Bot ----------------------------------------------------------
# The pinned OpenCode runtime must be on PATH: the Bot spawns `opencode serve`,
# and without it every session fails with `spawn opencode ENOENT`.
if [ -x "$ROOT/.core/bin/opencode" ]; then
  export PATH="$ROOT/.core/bin:$PATH"
  log "opencode on PATH: $(command -v opencode)"
else
  log "ERROR: $ROOT/.core/bin/opencode missing (run scripts/materialize-core-release.mjs)"
  exit 1
fi

# Local mode: CONTROL_APPLICATION_IPC is deliberately unset, so no Control Plane
# and no Railway are consulted. OPENCODE_TELEGRAM_HOME keeps all state outside
# the source tree. Do NOT set OPENCODE_TELEGRAM_CONTAINER: container mode turns
# recovery failure into process.exit(75).
export TELEGRAM_BOT_TOKEN="$SOAK_TOKEN"
export TELEGRAM_USER_ID="$SOAK_USER_ID"
export TELEGRAM_API_ROOT="http://127.0.0.1:$TELEGRAM_PORT"
export OPENCODE_TELEGRAM_HOME="$SOAK_HOME"
export OPENCODE_MODEL_PROVIDER="opencode"
export OPENCODE_MODEL_ID="big-pickle"
export LOG_LEVEL="${SOAK_LOG_LEVEL:-info}"
export BOT_LOCALE="en"
export SOAK_MODEL_PORT="$MODEL_PORT"
mkdir -p "$OPENCODE_TELEGRAM_HOME"

# Point the Bot at the stub model and select it. Must happen before first boot.
node "$SOAK/seed-state.mjs" || exit 1

unset CONTROL_APPLICATION_IPC RAILWAY_API_TOKEN 2>/dev/null || true

# Materialise the environment the Bot boots with, so a controlled restart
# (W7/G7) reuses the exact same one instead of reconstructing it: one
# definition, used by the first boot and by every restart.
cat >"$RUN_DIR/bot-env.sh" <<ENVEOF
export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
export TELEGRAM_USER_ID="$TELEGRAM_USER_ID"
export TELEGRAM_API_ROOT="$TELEGRAM_API_ROOT"
export OPENCODE_TELEGRAM_HOME="$OPENCODE_TELEGRAM_HOME"
export OPENCODE_MODEL_PROVIDER="$OPENCODE_MODEL_PROVIDER"
export OPENCODE_MODEL_ID="$OPENCODE_MODEL_ID"
export LOG_LEVEL="$LOG_LEVEL"
export BOT_LOCALE="$BOT_LOCALE"
export SOAK_MODEL_PORT="$SOAK_MODEL_PORT"
export PATH="$ROOT/.core/bin:\$PATH"
unset CONTROL_APPLICATION_IPC RAILWAY_API_TOKEN 2>/dev/null || true
ENVEOF

log "starting bot"
node "$ROOT/dist/index.js" >"$RUN_DIR/bot.log" 2>&1 &
PIDS+=($!)
BOT_PID="${PIDS[-1]}"
echo "$BOT_PID" > "$RUN_DIR/bot.pid"

# Durable checkpoints: push evidence every few minutes so an abrupt runner
# handoff keeps whatever was actually observed instead of losing it all.
if [ "${SOAK_PERSIST:-1}" = "1" ]; then
  (
    while kill -0 "$BOT_PID" 2>/dev/null && [ -d "$RUN_DIR" ]; do
      sleep "${SOAK_PERSIST_INTERVAL:-300}"
      bash "$SOAK/persist-evidence.sh" "$RUN_DIR" "$ROOT" >>"$RUN_DIR/persist.log" 2>&1 || true
    done
  ) &
  PERSIST_PID=$!
fi

# Give the bot time to run getMe / deleteWebhook / start long polling.
if ! wait_for_health "http://127.0.0.1:$TELEGRAM_PORT/__state" "telegram stub state" 60; then
  exit 1
fi
sleep "${SOAK_BOOT_WAIT:-8}"
if ! kill -0 "$BOT_PID" 2>/dev/null; then
  log "ERROR: bot exited during boot; last 40 log lines:"
  tail -40 "$RUN_DIR/bot.log"
  exit 1
fi
log "bot up (pid $BOT_PID)"

# --- run the stage ----------------------------------------------------------
node "$SOAK/driver.mjs" --stage "$STAGE" \
  --duration "$DURATION" \
  --active "${SOAK_ACTIVE_S:-0}" \
  --idle "${SOAK_IDLE_S:-0}" \
  --opencode-port "$OPENCODE_PORT" \
  --run-dir "$RUN_DIR" \
  --updates "$UPDATES" \
  --telegram-port "$TELEGRAM_PORT" \
  --token "$SOAK_TOKEN" \
  --user-id "$SOAK_USER_ID" \
  --restart-script "$SOAK/bot-restart.sh" \
  --rollback-script "$SOAK/bot-rollback.sh" \
  --repo-dir "$ROOT"
DRIVER_RC=$?

# --- capture post-state -----------------------------------------------------
# GNU procps rejects `ps -o ... --ppid` ("unsupported SysV option"), so select
# the bot and its children from the full process list instead.
ps -eo pid,ppid,rss,etime,cmd 2>/dev/null | awk -v p="$BOT_PID" 'NR==1 || $1==p || $2==p' \
  >"$RUN_DIR/evidence/processes.txt"
curl -fsS -m 5 "http://127.0.0.1:$TELEGRAM_PORT/__state" >"$RUN_DIR/evidence/telegram-state.json" 2>/dev/null
curl -fsS -m 5 "http://127.0.0.1:$MODEL_PORT/__state" >"$RUN_DIR/evidence/model-state.json" 2>/dev/null
cp "$RUN_DIR/bot.log" "$RUN_DIR/evidence/bot.log" 2>/dev/null
cp "$OPENCODE_TELEGRAM_HOME/app-state.json" "$RUN_DIR/evidence/app-state.json" 2>/dev/null

[ -n "${PERSIST_PID:-}" ] && kill "$PERSIST_PID" 2>/dev/null
if [ "${SOAK_PERSIST:-1}" = "1" ]; then
  bash "$SOAK/persist-evidence.sh" "$RUN_DIR" "$ROOT" >>"$RUN_DIR/persist.log" 2>&1 || true
fi

log "stage '$STAGE' finished with rc=$DRIVER_RC"
exit "$DRIVER_RC"

#!/usr/bin/env bash
# Roll the isolated soak Bot to an explicitly pinned commit, or restore its tested commit.
# Usage: bot-rollback.sh <run-dir> <repo-dir> <rollback|restore> <sha>
set -uo pipefail

RUN_DIR="${1:?run dir required}"
REPO_DIR="${2:?repo dir required}"
PHASE="${3:?phase required}"
SHA="${4:?sha required}"

if [ "$PHASE" != "rollback" ] && [ "$PHASE" != "restore" ]; then
  echo "bot-rollback: invalid phase=$PHASE" >&2
  exit 2
fi
ENV_FILE="$RUN_DIR/bot-env.sh"
if [ ! -f "$ENV_FILE" ]; then
  echo "bot-rollback: $ENV_FILE missing — run.sh did not materialise the Bot environment" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$ENV_FILE"
BOT_LOG="$RUN_DIR/bot.log"
rollback_marker() { echo "bot-rollback: $*" | tee -a "$BOT_LOG" >&2; }

OLD_PID="$(tr -d '[:space:]' <"$RUN_DIR/bot.pid" 2>/dev/null || true)"
GRACE_S="${BOT_RESTART_GRACE_S:-50}"
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  T_START=$(date +%s)
  kill "$OLD_PID" 2>/dev/null || true
  EXIT_KIND="graceful"
  for _ in $(seq 1 "$GRACE_S"); do
    kill -0 "$OLD_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$OLD_PID" 2>/dev/null; then
    EXIT_KIND="forced"
    kill -9 "$OLD_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      STATE="$(ps -o stat= -p "$OLD_PID" 2>/dev/null | tr -d '[:space:]' || true)"
      case "$STATE" in Z*) break ;; "") break ;; esac
      sleep 1
    done
  fi
  ELAPSED=$(( $(date +%s) - T_START ))
  if kill -0 "$OLD_PID" 2>/dev/null; then
    STATE="$(ps -o stat= -p "$OLD_PID" 2>/dev/null | tr -d '[:space:]' || true)"
    case "$STATE" in
      Z*) ;;
      *)
        rollback_marker "old pid=$OLD_PID exit=unkillable after ${ELAPSED}s state=${STATE:-unknown}"
        rollback_marker "exit=1"
        exit 1
        ;;
    esac
  fi
  rollback_marker "old pid=$OLD_PID exit=$EXIT_KIND after ${ELAPSED}s"
else
  rollback_marker "old pid=${OLD_PID:-none} exit=absent"
fi

CHECKOUT_MS=0
BUILD_MS=0
SPAWN_MS=0
if ! git -C "$REPO_DIR" cat-file -e "${SHA}^{commit}" 2>/dev/null; then
  CHECKOUT_MS="$(date +%s%3N)"
  rollback_marker "phase=$PHASE sha=$SHA checkout=$CHECKOUT_MS build=$BUILD_MS spawn=$SPAWN_MS"
  rollback_marker "exit=2"
  exit 2
fi
if ! git -C "$REPO_DIR" checkout --quiet --detach "$SHA"; then
  CHECKOUT_MS="$(date +%s%3N)"
  rollback_marker "phase=$PHASE sha=$SHA checkout=$CHECKOUT_MS build=$BUILD_MS spawn=$SPAWN_MS"
  rollback_marker "exit=2"
  exit 2
fi
CHECKOUT_MS="$(date +%s%3N)"
if ! npm --prefix "$REPO_DIR" run build >>"$RUN_DIR/rollback-$PHASE.log" 2>&1; then
  BUILD_MS="$(date +%s%3N)"
  rollback_marker "phase=$PHASE sha=$SHA checkout=$CHECKOUT_MS build=$BUILD_MS spawn=$SPAWN_MS"
  rollback_marker "exit=3"
  exit 3
fi
BUILD_MS="$(date +%s%3N)"
node "$REPO_DIR/dist/index.js" >>"$BOT_LOG" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" >"$RUN_DIR/bot.pid"
SPAWN_MS="$(date +%s%3N)"
rollback_marker "started new pid=$NEW_PID"
rollback_marker "phase=$PHASE sha=$SHA checkout=$CHECKOUT_MS build=$BUILD_MS spawn=$SPAWN_MS"
rollback_marker "exit=0"

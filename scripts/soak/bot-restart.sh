#!/usr/bin/env bash
# Controlled restart for W7 / G7: stop the Bot and start it again from the same
# environment, so "the environment came back" (D5) is measured instead of
# assumed.
#
# Usage: bot-restart.sh <run-dir> <repo-dir>
#
# The environment the Bot boots with — home, stub endpoints, the pinned
# OpenCode on PATH, local-mode unsets — is materialised by run.sh into
# <run-dir>/bot-env.sh and used by both the first boot and every restart, so
# there is exactly one definition. Nothing is reseeded: whatever state survives
# a restart is whatever the Bot persisted itself, which is the claim G7 makes.
set -uo pipefail

RUN_DIR="${1:?run dir required}"
REPO_DIR="${2:?repo dir required}"

ENV_FILE="$RUN_DIR/bot-env.sh"
if [ ! -f "$ENV_FILE" ]; then
  echo "bot-restart: $ENV_FILE missing — run.sh did not materialise the Bot environment" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

OLD_PID="$(tr -d '[:space:]' <"$RUN_DIR/bot.pid" 2>/dev/null || true)"
BOT_LOG="$RUN_DIR/bot.log"
restart_marker() { echo "bot-restart: $*" | tee -a "$BOT_LOG" >&2; }

# How long to wait for the Bot's own graceful shutdown. Its SIGTERM handler
# drains in-flight work for up to 45000ms before forcing exit, so a shorter
# grace escalates every restart of an active Bot to SIGKILL — and stress run
# 38393992089 then refused outright: kill -0 was evaluated immediately after
# kill -9, succeeded against the not-yet-reaped process, and the script exited
# without starting a new Bot, leaving every later cycle timing out against a
# dead environment. The grace must outlast the Bot's deadline, and death must
# be settled (a zombie counts as dead) before any refusal.
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
      case "$STATE" in
        Z*) break ;; # zombie: dead, only awaiting its parent's reap
        "") break ;;
      esac
      sleep 1
    done
  fi
  ELAPSED=$(( $(date +%s) - T_START ))
  if kill -0 "$OLD_PID" 2>/dev/null; then
    STATE="$(ps -o stat= -p "$OLD_PID" 2>/dev/null | tr -d '[:space:]' || true)"
    case "$STATE" in
      Z*) ;; # dead: fall through and start the new Bot
      *)
        restart_marker "old pid=$OLD_PID exit=unkillable after ${ELAPSED}s state=${STATE:-unknown}"
        echo "bot-restart: old bot pid=$OLD_PID is still alive after ${ELAPSED}s (state=${STATE:-unknown}); refusing to continue" >&2
        exit 1
        ;;
    esac
  fi
  restart_marker "old pid=$OLD_PID exit=$EXIT_KIND after ${ELAPSED}s"
else
  restart_marker "old pid=${OLD_PID:-none} exit=absent"
fi

node "$REPO_DIR/dist/index.js" >>"$RUN_DIR/bot.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" >"$RUN_DIR/bot.pid"
restart_marker "started new pid=$NEW_PID"
echo "bot-restart: pid ${OLD_PID:-none} -> $NEW_PID"

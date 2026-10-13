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
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  kill "$OLD_PID" 2>/dev/null || true
  # The same grace period run.sh's cleanup allows before escalating.
  for _ in $(seq 1 15); do
    kill -0 "$OLD_PID" 2>/dev/null || break
    sleep 1
  done
  kill -9 "$OLD_PID" 2>/dev/null || true
fi
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  echo "bot-restart: old bot pid=$OLD_PID is still alive after 15s; refusing to continue" >&2
  exit 1
fi

node "$REPO_DIR/dist/index.js" >>"$RUN_DIR/bot.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" >"$RUN_DIR/bot.pid"
echo "bot-restart: pid ${OLD_PID:-none} -> $NEW_PID"

#!/usr/bin/env bash
# Push soak evidence to the soak-evidence branch so a crash, runner handoff or
# conversation restart cannot erase it. Safe to call repeatedly; failures are
# reported but never fatal for the caller.
#
# Usage: persist-evidence.sh <run-dir> [repo-dir]
set -uo pipefail

RUN_DIR="${1:?usage: persist-evidence.sh <run-dir> [repo-dir]}"
REPO_DIR="${2:-$(pwd)}"
BRANCH="soak-evidence"

if [ ! -d "$RUN_DIR" ]; then
  echo "persist-evidence: no such run dir: $RUN_DIR" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/soak-evidence.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

cd "$REPO_DIR" || exit 1
REMOTE="$(git remote get-url origin 2>/dev/null || true)"
if [ -z "$REMOTE" ]; then
  echo "persist-evidence: no origin remote in $REPO_DIR" >&2
  exit 1
fi

if git clone --quiet --branch "$BRANCH" --single-branch --depth 1 "$REMOTE" "$WORK" 2>/dev/null; then
  :
else
  # Branch does not exist yet: seed it from the current checkout's tree.
  git clone --quiet --depth 1 "file://$REPO_DIR" "$WORK" || exit 1
  git -C "$WORK" checkout --quiet --orphan "$BRANCH" || exit 1
  git -C "$WORK" rm -rq --cached . >/dev/null 2>&1 || true
  find "$WORK" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
fi

DEST="$WORK/evidence/$(basename "$RUN_DIR")"
mkdir -p "$DEST"
# Copy only the evidence subtree, never the whole run directory (which contains
# the bot's private home and can be large).
if [ -d "$RUN_DIR/evidence" ]; then
  cp -R "$RUN_DIR/evidence/." "$DEST/" 2>/dev/null || true
fi
cp "$RUN_DIR"/bot.log "$DEST/bot.log" 2>/dev/null || true
cp "$RUN_DIR"/*.jsonl "$DEST/" 2>/dev/null || true

cd "$WORK" || exit 1
git add -A
if git diff --cached --quiet; then
  echo "persist-evidence: nothing new to push"
  exit 0
fi

git -c user.name="soak-harness" -c user.email="soak-harness@users.noreply.github.com" \
  commit -q -m "evidence: ${STAMP}" || exit 1

for attempt in 1 2 3; do
  if git push --quiet origin "$BRANCH" 2>/dev/null; then
    echo "persist-evidence: pushed $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep $((attempt * 3))
done

echo "persist-evidence: push failed after 3 attempts (offline?)" >&2
exit 1

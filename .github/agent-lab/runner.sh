#!/usr/bin/env bash
set -Eeuo pipefail

ACTION="${1:-status}"
shift || true

ROOT="${AGENT_PROJECT_ROOT:-$(git rev-parse --show-toplevel)}"
CACHE_ROOT="${AGENT_PROJECT_CACHE_DIR:?AGENT_PROJECT_CACHE_DIR is required}"
LOCK_FILE="$ROOT/package-lock.json"
CI_TEST_SOURCE="$ROOT/.github/ci-tests/tests"
VITEST_CONFIG="$ROOT/.github/ci-tests/vitest.config.ts"

[[ -f "$LOCK_FILE" ]] || { echo "package-lock.json is required." >&2; exit 2; }
lock_hash="$(sha256sum "$LOCK_FILE" | awk '{print $1}')"
ENV_DIR="$CACHE_ROOT/node-${lock_hash}"
NODE_MODULES="$ENV_DIR/node_modules"
NPM_CACHE="$CACHE_ROOT/npm-downloads"
MARKER="$ENV_DIR/.agent-lab-ready"

materialize_tests() {
  local exclude_file="$ROOT/.git/info/exclude"
  if [[ -d "$ROOT/.git" ]]; then
    mkdir -p "$(dirname "$exclude_file")"
    grep -qxF "/tests/" "$exclude_file" 2>/dev/null || echo "/tests/" >> "$exclude_file"
  fi
  rm -rf "$ROOT/tests"
  mkdir -p "$ROOT/tests"
  cp -R "$CI_TEST_SOURCE/." "$ROOT/tests/"
}

link_environment() {
  rm -rf "$ROOT/node_modules"
  ln -s "$NODE_MODULES" "$ROOT/node_modules"
}

prepare_environment() {
  mkdir -p "$CACHE_ROOT" "$NPM_CACHE"
  if [[ ! -f "$MARKER" || ! -x "$NODE_MODULES/.bin/tsc" || ! -x "$NODE_MODULES/.bin/vitest" ]]; then
    tmp="$CACHE_ROOT/.node-${lock_hash}.tmp.$$"
    rm -rf "$tmp"
    mkdir -p "$tmp"
    cp "$ROOT/package.json" "$LOCK_FILE" "$tmp/"
    (
      cd "$tmp"
      npm_config_cache="$NPM_CACHE" npm_config_audit=false npm_config_fund=false npm ci
      npm_config_cache="$NPM_CACHE" npm_config_audit=false npm_config_fund=false \
        npm install --no-save --package-lock=false vitest@3.2.4
    )
    rm -rf "$ENV_DIR"
    mv "$tmp" "$ENV_DIR"
    printf 'lock=%s\nprepared=%s\n' "$lock_hash" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > "$MARKER"
  fi
  link_environment
  materialize_tests
}

case "$ACTION" in
  prepare)
    prepare_environment
    echo "AGENT_PROJECT_READY=true"
    echo "AGENT_PROJECT_DEP_CACHE=$ENV_DIR"
    ;;
  status)
    echo "AGENT_PROJECT_LOCK_HASH=$lock_hash"
    echo "AGENT_PROJECT_DEP_CACHE=$ENV_DIR"
    if [[ -f "$MARKER" && -x "$NODE_MODULES/.bin/vitest" ]]; then
      echo "AGENT_PROJECT_READY=true"
    else
      echo "AGENT_PROJECT_READY=false"
    fi
    ;;
  check)
    prepare_environment
    cd "$ROOT"
    npm run lint
    npm run typecheck
    npm run build
    ;;
  test)
    prepare_environment
    if (($# == 0)); then
      echo "Targeted test selector required. The full suite belongs to GitHub Actions CI." >&2
      exit 2
    fi
    cd "$ROOT"
    selectors=()
    for selector in "$@"; do
      selector="${selector#./}"
      selector="${selector#.github/ci-tests/}"
      selectors+=("$selector")
    done
    "$NODE_MODULES/.bin/vitest" run --config "$VITEST_CONFIG" "${selectors[@]}"
    ;;
  clean-materialized)
    rm -rf "$ROOT/tests"
    if [[ -L "$ROOT/node_modules" ]]; then rm "$ROOT/node_modules"; fi
    ;;
  *)
    echo "Usage: .github/agent-lab/runner.sh {prepare|status|check|test SELECTOR...|clean-materialized}" >&2
    exit 2
    ;;
esac

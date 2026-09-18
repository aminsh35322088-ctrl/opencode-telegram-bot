#!/usr/bin/env bash
set -Eeuo pipefail

ACTION="${1:-status}"
shift || true

ROOT="${AGENT_PROJECT_ROOT:-$PWD}"
CACHE="${AGENT_PROJECT_CACHE_DIR:?AGENT_PROJECT_CACHE_DIR is required}"
DEPS_ROOT="$CACHE/deps"
TESTS_DIR="$ROOT/tests"

cd "$ROOT"

lock_hash() {
  sha256sum package-lock.json | awk '{print $1}'
}

deps_dir() {
  printf '%s/%s\n' "$DEPS_ROOT" "$(lock_hash)"
}

ensure_deps() {
  [[ -f package.json && -f package-lock.json ]] || {
    echo "package.json/package-lock.json are required." >&2
    exit 4
  }

  local deps marker tmp
  deps="$(deps_dir)"
  marker="$deps/.agent-ready"

  if [[ ! -s "$marker" || ! -x "$deps/node_modules/.bin/tsc" || ! -x "$deps/node_modules/.bin/vitest" ]]; then
    echo "[project] Building dependency cache for lock $(lock_hash | cut -c1-12)."
    tmp="${deps}.tmp.$$"
    rm -rf "$tmp"
    mkdir -p "$tmp"
    cp package.json package-lock.json "$tmp/"
    (
      cd "$tmp"
      npm_config_audit=false npm_config_fund=false npm ci
      npm_config_audit=false npm_config_fund=false         npm install --no-save --package-lock=false vitest@3.2.4
    )
    printf 'ready_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > "$tmp/.agent-ready"
    rm -rf "$deps"
    mkdir -p "$(dirname "$deps")"
    mv "$tmp" "$deps"
  else
    echo "[project] Reusing cached dependencies: $deps"
  fi

  if [[ -e node_modules && ! -L node_modules ]]; then
    echo "Refusing to replace a real workspace node_modules directory." >&2
    exit 5
  fi
  ln -sfn "$deps/node_modules" node_modules

  echo "AGENT_PROJECT_DEPS=$deps"
}

materialize_tests() {
  rm -rf "$TESTS_DIR"
  mkdir -p "$TESTS_DIR"
  cp -R .github/ci-tests/tests/. "$TESTS_DIR/"
}

normalize_selector() {
  local value="$1"
  value="${value#./}"
  if [[ "$value" == .github/ci-tests/tests/* ]]; then
    value="tests/${value#.github/ci-tests/tests/}"
  fi
  printf '%s\n' "$value"
}

case "$ACTION" in
  status)
    deps="$(deps_dir)"
    echo "PROJECT=opencode-telegram-bot"
    echo "ROOT=$ROOT"
    echo "LOCK_HASH=$(lock_hash)"
    echo "DEPS_DIR=$deps"
    if [[ -s "$deps/.agent-ready" ]]; then
      echo "DEPS_CACHE=READY"
    else
      echo "DEPS_CACHE=MISSING"
    fi
    ;;

  prepare)
    ensure_deps
    ;;

  check)
    ensure_deps
    npm run lint
    npm run typecheck
    npm run build
    ;;

  test)
    (($# > 0)) || {
      echo "Targeted test selectors are required on Runner Lab." >&2
      echo "The full suite remains GitHub Actions CI-only per AGENTS.md." >&2
      exit 6
    }
    ensure_deps
    materialize_tests
    trap 'rm -rf "$TESTS_DIR"' EXIT
    selectors=()
    for selector in "$@"; do
      selectors+=("$(normalize_selector "$selector")")
    done
    ./node_modules/.bin/vitest run       --config .github/ci-tests/vitest.config.ts       "${selectors[@]}"
    ;;

  clean)
    rm -rf "$TESTS_DIR"
    if [[ -L node_modules ]]; then
      rm -f node_modules
    fi
    ;;

  *)
    echo "Usage: .github/agent-lab/runner.sh {status|prepare|check|test <selectors...>|clean}" >&2
    exit 2
    ;;
esac

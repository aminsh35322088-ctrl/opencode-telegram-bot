#!/bin/sh
set -u

DATA_ROOT="/data"
WARN_MB="${OPENCODE_DATA_VOLUME_WARN_MB:-150}"
OPENCODE_DB="$DATA_ROOT/.local/share/opencode/opencode.db"
PERSISTENT_REPO="$DATA_ROOT/opencode/opencode-telegram-bot"

free_mb() {
  df -Pk "$DATA_ROOT" 2>/dev/null | awk 'NR==2 {print int($4 / 1024)}'
}

before_mb="$(free_mb || true)"
printf '%s\n' "[railway-maintenance] Starting safe volume maintenance: free=${before_mb:-unknown}MB"

# GitHub CLI run-log archives are a disposable cache. They accumulate quickly
# during CI/debug sessions and are safe to regenerate on demand.
if [ -d "$DATA_ROOT/.cache/gh" ]; then
  rm -rf "$DATA_ROOT/.cache/gh" || true
  printf '%s\n' "[railway-maintenance] Cleared disposable GitHub CLI cache"
fi

# OpenCode uses SQLite WAL mode. At startup there should be no bot-owned DB
# connection yet, so make a short best-effort checkpoint if a WAL is present.
# TRUNCATE preserves committed data while reclaiming the WAL file after a
# successful checkpoint. A busy/failed checkpoint is non-fatal.
if [ -f "$OPENCODE_DB-wal" ] && command -v sqlite3 >/dev/null 2>&1; then
  wal_bytes="$(wc -c < "$OPENCODE_DB-wal" 2>/dev/null || echo 0)"
  if [ "${wal_bytes:-0}" -ge 8388608 ]; then
    if timeout 6 sqlite3 "$OPENCODE_DB" 'PRAGMA busy_timeout=1000; PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1; then
      printf '%s\n' "[railway-maintenance] Checkpointed OpenCode WAL (${wal_bytes} bytes before checkpoint)"
    else
      printf '%s\n' "[railway-maintenance] OpenCode WAL checkpoint skipped/blocked; continuing startup"
    fi
  fi
fi

after_cache_mb="$(free_mb || true)"
if [ -n "$after_cache_mb" ] && [ "$after_cache_mb" -lt "$WARN_MB" ] && [ -d "$PERSISTENT_REPO/.git" ]; then
  printf '%s\n' "[railway-maintenance] Low free space (${after_cache_mb}MB); compacting persistent Git repository"
  # Use normal git-gc semantics rather than --prune=now. This packs reachable
  # loose objects while retaining Git's normal safety window for recent
  # unreachable objects.
  if timeout 45 su -s /bin/sh node -c "git -C '$PERSISTENT_REPO' gc --quiet"; then
    printf '%s\n' "[railway-maintenance] Persistent Git repository compacted"
  else
    printf '%s\n' "[railway-maintenance] Git compaction skipped/failed; continuing startup"
  fi
fi

after_mb="$(free_mb || true)"
printf '%s\n' "[railway-maintenance] Completed safe volume maintenance: free=${after_mb:-unknown}MB"

exec /app/railway-entrypoint.sh

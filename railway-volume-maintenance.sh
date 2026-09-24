#!/bin/sh
set -u

DATA_ROOT="/data"
WARN_MB="${OPENCODE_DATA_VOLUME_WARN_MB:-150}"
CRITICAL_MB="${OPENCODE_DATA_VOLUME_CRITICAL_MB:-100}"
OPENCODE_DB="$DATA_ROOT/.local/share/opencode/opencode.db"
OPENCODE_LOG="$DATA_ROOT/.local/share/opencode/log/opencode.log"
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

# Preserve recent OpenCode diagnostics without allowing the previous process log
# to consume a large fraction of the tiny persistent volume. This runs before
# OpenCode starts, so there is no active writer to this file yet.
if [ -f "$OPENCODE_LOG" ]; then
  log_bytes="$(wc -c < "$OPENCODE_LOG" 2>/dev/null || echo 0)"
  if [ "${log_bytes:-0}" -ge 8388608 ]; then
    log_tmp="$OPENCODE_LOG.maintenance-tmp"
    if tail -c 1048576 "$OPENCODE_LOG" > "$log_tmp" 2>/dev/null && cat "$log_tmp" > "$OPENCODE_LOG"; then
      rm -f "$log_tmp"
      printf '%s\n' "[railway-maintenance] Trimmed OpenCode log from ${log_bytes} bytes to the most recent 1MB"
    else
      rm -f "$log_tmp"
      printf '%s\n' "[railway-maintenance] OpenCode log trim skipped/failed; continuing startup"
    fi
  fi
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

# Compact deleted SQLite pages only at startup, before OpenCode owns the DB.
# The helper vacuums to ephemeral /tmp, verifies integrity, and only copies the
# compact candidate back when the persistent filesystem has enough headroom.
if [ -f "$OPENCODE_DB" ] && [ -f /app/scripts/opencode-db-maintenance.mjs ]; then
  node /app/scripts/opencode-db-maintenance.mjs || true
fi

after_initial_mb="$(free_mb || true)"
if [ -n "$after_initial_mb" ] && [ "$after_initial_mb" -lt "$CRITICAL_MB" ]; then
  printf '%s\n' "[railway-maintenance] Critical free space (${after_initial_mb}MB); removing rebuildable runtime artifacts"

  # These locations contain generated or cache-only data. Keep app-state,
  # OpenCode DB/session state, workspaces, credentials, and user files intact.
  if [ -d "$DATA_ROOT/.cache" ]; then
    find "$DATA_ROOT/.cache" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
  fi
  if [ -d "$DATA_ROOT/run" ]; then
    find "$DATA_ROOT/run" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
  fi
  if [ -d "$DATA_ROOT/.local/share/opencode/tool-output" ]; then
    rm -rf "$DATA_ROOT/.local/share/opencode/tool-output" || true
  fi
  if [ -e "$PERSISTENT_REPO/node_modules" ] || [ -L "$PERSISTENT_REPO/node_modules" ]; then
    rm -rf "$PERSISTENT_REPO/node_modules" || true
  fi

  # If disposable caches were not enough, retain only the newest 256KB of the
  # previous OpenCode process log. Maintenance runs before OpenCode starts, so
  # there is no active writer and no session/database state is affected.
  after_disposable_mb="$(free_mb || true)"
  if [ -n "$after_disposable_mb" ] && [ "$after_disposable_mb" -lt "$CRITICAL_MB" ] && [ -f "$OPENCODE_LOG" ]; then
    log_bytes="$(wc -c < "$OPENCODE_LOG" 2>/dev/null || echo 0)"
    if [ "${log_bytes:-0}" -gt 262144 ]; then
      log_tmp="$OPENCODE_LOG.maintenance-critical-tmp"
      if tail -c 262144 "$OPENCODE_LOG" > "$log_tmp" 2>/dev/null && cat "$log_tmp" > "$OPENCODE_LOG"; then
        rm -f "$log_tmp"
        printf '%s\n' "[railway-maintenance] Emergency-trimmed OpenCode log from ${log_bytes} bytes to the most recent 256KB"
      else
        rm -f "$log_tmp"
        printf '%s\n' "[railway-maintenance] Emergency OpenCode log trim skipped/failed; continuing startup"
      fi
    fi
  fi

  after_emergency_mb="$(free_mb || true)"
  printf '%s\n' "[railway-maintenance] Emergency cleanup complete: free=${after_emergency_mb:-unknown}MB"
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

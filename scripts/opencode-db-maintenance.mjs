import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function asPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function fsFreeBytes(target) {
  const stats = fs.statfsSync(target);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function inspectOpenCodeDatabase(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const pageSize = Number(db.pragma("page_size", { simple: true }));
    const pageCount = Number(db.pragma("page_count", { simple: true }));
    const freelistCount = Number(db.pragma("freelist_count", { simple: true }));
    const autoVacuum = Number(db.pragma("auto_vacuum", { simple: true }));
    const journalMode = String(db.pragma("journal_mode", { simple: true }));
    return {
      pageSize,
      pageCount,
      freelistCount,
      autoVacuum,
      journalMode,
      reclaimableBytes: pageSize * freelistCount,
      logicalBytes: pageSize * pageCount,
    };
  } finally {
    db.close();
  }
}

export function maintainOpenCodeDatabase(dbPath, options = {}) {
  const minReclaimBytes = asPositiveNumber(options.minReclaimBytes, 8 * 1024 * 1024);
  const minReclaimRatio = asPositiveNumber(options.minReclaimRatio, 0.08);
  const reserveBytes = asPositiveNumber(options.reserveBytes, 16 * 1024 * 1024);
  const tempDir = options.tempDir || os.tmpdir();
  const log = typeof options.log === "function" ? options.log : () => {};

  if (!fs.existsSync(dbPath)) {
    return {
      compacted: false,
      beforeBytes: 0,
      afterBytes: 0,
      reclaimableBytes: 0,
      integrity: "missing",
    };
  }

  const sourceStat = fs.statSync(dbPath);
  const beforeBytes = sourceStat.size;

  // Startup maintenance runs before OpenCode itself starts. A best-effort
  // checkpoint makes the main file authoritative and reclaims stale WAL bytes.
  const writable = new Database(dbPath, { fileMustExist: true });
  try {
    writable.pragma("busy_timeout = 1000");
    try {
      writable.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      log(`WAL checkpoint skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    writable.pragma("optimize");
  } finally {
    writable.close();
  }

  const diagnostics = inspectOpenCodeDatabase(dbPath);
  const reclaimRatio =
    diagnostics.logicalBytes > 0 ? diagnostics.reclaimableBytes / diagnostics.logicalBytes : 0;

  if (
    diagnostics.reclaimableBytes < minReclaimBytes ||
    reclaimRatio < minReclaimRatio
  ) {
    return {
      compacted: false,
      beforeBytes,
      afterBytes: fs.statSync(dbPath).size,
      reclaimableBytes: diagnostics.reclaimableBytes,
      integrity: "not-run",
    };
  }

  fs.mkdirSync(tempDir, { recursive: true });
  const vacuumPath = path.join(
    tempDir,
    `opencode-vacuum-${process.pid}-${Date.now()}.db`,
  );
  const sameFsTemp = `${dbPath}.compact-${process.pid}.tmp`;

  try {
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      db.exec(`VACUUM INTO ${sqlString(vacuumPath)}`);
    } finally {
      db.close();
    }

    const verify = new Database(vacuumPath, { readonly: true, fileMustExist: true });
    let integrity;
    try {
      integrity = String(verify.pragma("integrity_check", { simple: true }));
    } finally {
      verify.close();
    }
    if (integrity !== "ok") {
      throw new Error(`compacted OpenCode database failed integrity_check: ${integrity}`);
    }

    const compactBytes = fs.statSync(vacuumPath).size;
    const availableBytes = fsFreeBytes(path.dirname(dbPath));
    if (compactBytes + reserveBytes > availableBytes) {
      log(
        `Compaction candidate needs ${compactBytes} bytes but only ${availableBytes} bytes are free on the persistent filesystem; skipping replace`,
      );
      return {
        compacted: false,
        beforeBytes,
        afterBytes: fs.statSync(dbPath).size,
        reclaimableBytes: diagnostics.reclaimableBytes,
        integrity,
      };
    }

    fs.copyFileSync(vacuumPath, sameFsTemp);
    fs.chmodSync(sameFsTemp, sourceStat.mode & 0o777);
    try {
      fs.chownSync(sameFsTemp, sourceStat.uid, sourceStat.gid);
    } catch {
      // Non-root development/test environments may not allow chown.
    }
    const fd = fs.openSync(sameFsTemp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(sameFsTemp, dbPath);
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });

    const afterBytes = fs.statSync(dbPath).size;
    log(
      `Compacted OpenCode DB from ${beforeBytes} to ${afterBytes} bytes; reclaimable freelist was ${diagnostics.reclaimableBytes} bytes`,
    );
    return {
      compacted: true,
      beforeBytes,
      afterBytes,
      reclaimableBytes: diagnostics.reclaimableBytes,
      integrity,
    };
  } finally {
    fs.rmSync(vacuumPath, { force: true });
    fs.rmSync(sameFsTemp, { force: true });
  }
}

async function main() {
  const dbPath =
    process.env.OPENCODE_DB_PATH ||
    "/data/.local/share/opencode/opencode.db";
  const minReclaimBytes =
    asPositiveNumber(process.env.OPENCODE_DB_VACUUM_MIN_RECLAIM_MB, 8) *
    1024 *
    1024;
  const minReclaimRatio =
    asPositiveNumber(process.env.OPENCODE_DB_VACUUM_MIN_RECLAIM_RATIO, 0.08);
  const reserveBytes =
    asPositiveNumber(process.env.OPENCODE_DB_VACUUM_RESERVE_MB, 16) *
    1024 *
    1024;

  try {
    const result = maintainOpenCodeDatabase(dbPath, {
      minReclaimBytes,
      minReclaimRatio,
      reserveBytes,
      log: (message) => {
        process.stdout.write(`[railway-maintenance] ${message}\n`);
      },
    });
    process.stdout.write(
      `[railway-maintenance] OpenCode DB maintenance: compacted=${result.compacted}, before=${result.beforeBytes}, after=${result.afterBytes}, reclaimable=${result.reclaimableBytes}, integrity=${result.integrity}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[railway-maintenance] OpenCode DB maintenance skipped/failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

async function loadMaintenance() {
  const modulePath = path.join(process.cwd(), "scripts", "opencode-db-maintenance.mjs");
  return import(pathToFileURL(modulePath).href) as Promise<{
    maintainOpenCodeDatabase: (
      dbPath: string,
      options?: {
        minReclaimBytes?: number;
        minReclaimRatio?: number;
        tempDir?: string;
        reserveBytes?: number;
        log?: (message: string) => void;
      },
    ) => {
      compacted: boolean;
      beforeBytes: number;
      afterBytes: number;
      reclaimableBytes: number;
      integrity: string;
    };
  }>;
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-db-maintenance-"));
  tempRoots.push(root);
  return root;
}

describe("OpenCode DB maintenance", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("compacts deleted SQLite pages without losing remaining rows", async () => {
    const root = makeTempRoot();
    const dbPath = path.join(root, "opencode.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO payload(data) VALUES (?)");
    const payload = "x".repeat(64 * 1024);
    const tx = db.transaction(() => {
      for (let i = 0; i < 320; i += 1) insert.run(payload + i);
    });
    tx();
    db.exec("DELETE FROM payload WHERE id <= 280");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();

    const before = fs.statSync(dbPath).size;
    const { maintainOpenCodeDatabase } = await loadMaintenance();
    const result = maintainOpenCodeDatabase(dbPath, {
      minReclaimBytes: 1,
      minReclaimRatio: 0,
      tempDir: root,
      reserveBytes: 0,
    });

    const after = fs.statSync(dbPath).size;
    const verify = new Database(dbPath, { readonly: true });
    const count = verify.prepare("SELECT COUNT(*) AS count FROM payload").get() as { count: number };
    const integrity = verify.pragma("integrity_check", { simple: true });
    verify.close();

    expect(result.compacted).toBe(true);
    expect(result.reclaimableBytes).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(count.count).toBe(40);
    expect(integrity).toBe("ok");
    expect(result.integrity).toBe("ok");
  });

  it("does not rewrite a database with insignificant freelist space", async () => {
    const root = makeTempRoot();
    const dbPath = path.join(root, "opencode.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    db.prepare("INSERT INTO payload(data) VALUES (?)").run("keep");
    db.close();

    const beforeMtime = fs.statSync(dbPath).mtimeMs;
    const { maintainOpenCodeDatabase } = await loadMaintenance();
    const result = maintainOpenCodeDatabase(dbPath, {
      minReclaimBytes: 1024 * 1024,
      minReclaimRatio: 0.1,
      tempDir: root,
      reserveBytes: 0,
    });

    expect(result.compacted).toBe(false);
    expect(fs.statSync(dbPath).mtimeMs).toBe(beforeMtime);
  });
});

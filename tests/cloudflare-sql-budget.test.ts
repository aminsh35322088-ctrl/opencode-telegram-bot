import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase } from "../src/cloudflare/control-store.js";
import { ControlSqlBudget } from "../src/cloudflare/sql-budget.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  let now = Date.parse("2026-10-11T12:00:00Z");
  const raw: SqlDatabase = { exec: (q, ...args) => {
    if (q === "SELECT heavy") {
      let consumed = false;
      const cursor = {
        rowsRead: 0, rowsWritten: 0,
        next() { if (consumed) return { done: true, value: undefined }; consumed = true; this.rowsRead = 1_100_000; return { done: false, value: { result: 1 } }; },
        [Symbol.iterator]() { return this; },
      };
      return cursor as never;
    }
    return db.prepare(q).all(...args) as never;
  } };
  return { raw, setNow: (value: number) => { now = value; }, budget: () => new ControlSqlBudget(raw, () => now) };
}

test("budget charges rows scanned while consuming a cursor, rather than rows returned", () => {
  const f = fixture(), budget = f.budget();
  assert.equal(budget.backgroundAllowed(), true);
  assert.deepEqual([...budget.sql.exec("SELECT heavy")], [{ result: 1 }]);
  assert.equal(budget.snapshot().rowsRead, 1_100_000);
  assert.equal(budget.backgroundAllowed(), false);
  budget.flush();
  assert.equal(f.budget().backgroundAllowed(), false, "restart must not reset the budget");
  // Control-path SQL remains available after background work is suspended.
  assert.equal([...budget.sql.exec("SELECT 42 AS answer")][0]?.answer, 42);
});

test("read counters do not double-charge cursor inspection and reset on the next UTC day", () => {
  const f = fixture(), budget = f.budget();
  const cursor = budget.sql.exec("SELECT heavy");
  cursor.next(); cursor.next(); cursor.next();
  assert.equal(budget.snapshot().rowsRead, 1_100_000);
  budget.flush();
  f.setNow(Date.parse("2026-10-12T00:00:00Z"));
  assert.equal(budget.backgroundAllowed(), true);
  assert.equal(budget.snapshot().rowsRead, 0);
});

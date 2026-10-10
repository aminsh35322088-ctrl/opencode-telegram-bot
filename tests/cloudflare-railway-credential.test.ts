import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { RailwayCredentialStore } from "../src/cloudflare/railway-credential-store.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec: (q: string, ...args: unknown[]) => db.prepare(q).all(...(args as never[])) as never };
  new ControlStore(sql, (action) => action());
  return { db, sql, master: btoa("r".repeat(32)) };
}

test("Railway account token is encrypted at rest and decrypts only through infrastructure store", async () => {
  const f = fixture();
  const vault = new RailwayCredentialStore(f.sql, f.master);
  await vault.save({ accountId: "user-1", accountName: "Primary", token: "railway-secret-token" });
  const row = f.db.prepare("SELECT data FROM ui_state WHERE key='infrastructure:railway:credential'").get() as { data: string };
  assert.ok(!row.data.includes("railway-secret-token"));
  const read = await vault.read();
  assert.equal(read?.accountId, "user-1");
  assert.equal(read?.accountName, "Primary");
  assert.equal(read?.token, "railway-secret-token");
  assert.ok(Number.isFinite(Date.parse(read?.configuredAt ?? "")));
});

test("Railway token replacement preserves one-account ownership and rejects another account", async () => {
  const f = fixture();
  const vault = new RailwayCredentialStore(f.sql, f.master);
  await vault.save({ accountId: "user-1", accountName: "Primary", token: "first-token" });
  await vault.replace({ accountId: "user-1", accountName: "Primary", token: "second-token" });
  assert.equal((await vault.read())?.token, "second-token");
  await assert.rejects(
    vault.replace({ accountId: "user-2", accountName: "Other", token: "foreign-token" }),
    /railway_account_mismatch/,
  );
  assert.equal((await vault.read())?.token, "second-token");
});

test("Railway setup token input is protected before Telegram update persistence", async () => {
  const { protectRailwayCredentialUpdate, readRailwayCredentialInput } = await import("../src/cloudflare/railway-credential-store.js");
  const f = fixture();
  const expires = Date.now() + 60_000;
  f.sql.exec(
    "INSERT INTO ui_state(key,data) VALUES(?,?)",
    "form:7:-100:0",
    JSON.stringify({ kind: "railway_credential", generation: 3, expires }),
  );
  const update = {
    update_id: 99,
    message: { message_id: 4, text: "railway-account-token", chat: { id: -100 }, from: { id: 7 } },
  };
  const protectedUpdate = await protectRailwayCredentialUpdate(update, f.sql, f.master);
  assert.equal(protectedUpdate.message?.text, "[credential input protected]");
  assert.ok(!JSON.stringify(protectedUpdate).includes("railway-account-token"));
  assert.equal(
    await readRailwayCredentialInput(protectedUpdate, f.master, {
      actor: 7,
      chat: -100,
      thread: 0,
      generation: 3,
    }),
    "railway-account-token",
  );
});

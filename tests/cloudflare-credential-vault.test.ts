import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase } from "../src/cloudflare/control-store.js";
import type { TelegramUpdate } from "../src/cloudflare/bot-ui.js";
import {
  CloudCredentialVault,
  protectTelegramCredentialUpdate,
  readCredentialInput,
} from "../src/cloudflare/credential-vault.js";
const master = btoa("k".repeat(32));
const secret = "provider-secret-example";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ui_state(key TEXT PRIMARY KEY,data TEXT NOT NULL)");
  const sql: SqlDatabase = { exec: (q, ...v) => db.prepare(q).all(...v) as never };
  return {
    db,
    sql,
    vault: new CloudCredentialVault(sql, master),
    dump: () => JSON.stringify(db.prepare("SELECT * FROM ui_state").all()),
  };
}
const context = { actor: 7, chat: -100, thread: 2, generation: 3, providerId: "openai" };
function update(text = secret): TelegramUpdate {
  return {
    update_id: 42,
    message: { message_id: 9, chat: { id: -100 }, from: { id: 7 }, message_thread_id: 2, text },
  };
}
function form(f: ReturnType<typeof fixture>, expires = Date.now() + 60_000) {
  f.sql.exec(
    "INSERT INTO ui_state VALUES(?,?)",
    "form:7:-100:2",
    JSON.stringify({ kind: "credential", providerId: "openai", generation: 3, expires }),
  );
}
test("provider credential storage and public metadata contain no plaintext", async () => {
  const f = fixture();
  const metadata = await f.vault.saveProvider("openai", secret);
  assert.deepEqual(Object.keys(metadata).sort(), [
    "capability",
    "configured",
    "credentialId",
    "id",
  ]);
  assert.equal(metadata.id, "openai");
  assert.equal(metadata.capability, "model-provider:openai");
  assert.match(metadata.credentialId, /^[0-9a-f-]{36}$/);
  assert.equal(f.dump().includes(secret), false);
  assert.equal(JSON.stringify(metadata).includes(secret), false);
  const lease = await new CloudCredentialVault(f.sql, master).readLease(
    metadata.capability,
    metadata.credentialId,
  );
  assert.equal(lease.value, secret);
  assert.ok(lease.expiresAt > Date.now());
  await assert.rejects(
    f.vault.readLease("model-provider:anthropic", metadata.credentialId),
    /invalid_credential/,
  );
  await assert.rejects(
    f.vault.readLease(metadata.capability, crypto.randomUUID()),
    /invalid_credential/,
  );
  await f.vault.remove("openai", metadata.credentialId);
  await assert.rejects(
    f.vault.readLease(metadata.capability, metadata.credentialId),
    /invalid_credential/,
  );
});
test("provider validation rejects privileged names, controls and oversized values", async () => {
  const f = fixture();
  for (const id of [
    "railway",
    "RAILWAY_API_TOKEN",
    "telegram",
    "TELEGRAM_BOT_TOKEN",
    "tg",
    "bad\nname",
    "a".repeat(129),
  ]) {
    await assert.rejects(f.vault.saveProvider(id, secret), /invalid_provider/);
  }
  for (const value of ["", "a\nb", "a\rb", "a".repeat(16385)])
    await assert.rejects(f.vault.saveProvider("openai", value), /invalid_credential/);
  assert.equal(f.dump().includes(secret), false);
});
test("vault rotation revokes old references and corruption errors are sanitized", async () => {
  const f = fixture();
  const first = await f.vault.saveProvider("openai", secret);
  const second = await f.vault.saveProvider("openai", "rotated");
  await assert.rejects(
    f.vault.readLease(first.capability, first.credentialId),
    /invalid_credential/,
  );
  await assert.rejects(
    new CloudCredentialVault(f.sql, "invalid").readLease(second.capability, second.credentialId),
    /^Error: invalid_credential$/,
  );
  const row = f.db.prepare("SELECT data FROM ui_state WHERE key=?").get("credential:openai") as {
    data: string;
  };
  const data = JSON.parse(row.data);
  data.ciphertext = secret;
  f.sql.exec("UPDATE ui_state SET data=? WHERE key=?", JSON.stringify(data), "credential:openai");
  await assert.rejects(
    f.vault.readLease(second.capability, second.credentialId),
    /^Error: invalid_credential$/,
  );
});
test("active credential input is encrypted before persistence and preserves Telegram fields", async () => {
  const f = fixture();
  form(f);
  const original = update();
  const protectedUpdate = await protectTelegramCredentialUpdate(original, f.sql, master);
  assert.equal(original.message?.text, secret);
  assert.equal(JSON.stringify(protectedUpdate).includes(secret), false);
  assert.equal(protectedUpdate.message?.message_id, 9);
  assert.equal(await readCredentialInput(protectedUpdate, master, context), secret);
  f.sql.exec("INSERT INTO ui_state VALUES(?,?)", "update:42", JSON.stringify(protectedUpdate));
  assert.equal(f.dump().includes(secret), false);
  for (const wrong of [
    { ...context, actor: 8 },
    { ...context, chat: -101 },
    { ...context, thread: 4 },
    { ...context, generation: 4 },
    { ...context, providerId: "anthropic" },
  ]) {
    await assert.rejects(
      readCredentialInput(protectedUpdate, master, wrong),
      /^Error: invalid_credential_input$/,
    );
  }
  await assert.rejects(
    readCredentialInput({ ...protectedUpdate, update_id: 43 }, master, context),
    /^Error: invalid_credential_input$/,
  );
  await assert.rejects(
    readCredentialInput(protectedUpdate, "invalid", context),
    /^Error: invalid_credential_input$/,
  );
});
test("expired credential forms redact input and cannot activate credentials", async () => {
  const f = fixture();
  form(f, Date.now() - 1);
  const protectedUpdate = await protectTelegramCredentialUpdate(update(), f.sql, master);
  assert.equal(JSON.stringify(protectedUpdate).includes(secret), false);
  assert.equal(protectedUpdate.message?.text, "[credential input protected]");
  assert.ok(protectedUpdate.credentialInput);
  await assert.rejects(
    readCredentialInput(protectedUpdate, master, context),
    /^Error: invalid_credential_input$/,
  );
  f.sql.exec("INSERT INTO ui_state VALUES(?,?)", "update:42", JSON.stringify(protectedUpdate));
  assert.equal(f.dump().includes(secret), false);
});
test("commands and other actors never intercept ordinary Telegram updates", async () => {
  const f = fixture();
  form(f);
  assert.deepEqual(
    await protectTelegramCredentialUpdate(update("/cancel"), f.sql, master),
    update("/cancel"),
  );
  const other = update();
  other.message!.from!.id = 8;
  assert.deepEqual(await protectTelegramCredentialUpdate(other, f.sql, master), other);
});

test("AES authentication rejects copied ciphertext with rewritten scope or metadata", async () => {
  const f = fixture();
  form(f);
  const protectedUpdate = await protectTelegramCredentialUpdate(update(), f.sql, master);
  const forged = structuredClone(protectedUpdate);
  forged.credentialInput!.generation = 4;
  await assert.rejects(
    readCredentialInput(forged, master, { ...context, generation: 4 }),
    /^Error: invalid_credential_input$/,
  );
  const providerForgery = structuredClone(protectedUpdate);
  providerForgery.credentialInput!.providerId = "anthropic";
  await assert.rejects(
    readCredentialInput(providerForgery, master, { ...context, providerId: "anthropic" }),
    /^Error: invalid_credential_input$/,
  );
  const expiryForgery = structuredClone(protectedUpdate);
  expiryForgery.credentialInput!.expires += 60_000;
  await assert.rejects(
    readCredentialInput(expiryForgery, master, context),
    /^Error: invalid_credential_input$/,
  );
  const expired = structuredClone(protectedUpdate);
  expired.credentialInput!.expires = Date.now() - 1;
  await assert.rejects(
    readCredentialInput(expired, master, context),
    /^Error: invalid_credential_input$/,
  );
  const metadata = await f.vault.saveProvider("openai", secret);
  const row = f.db.prepare("SELECT data FROM ui_state WHERE key=?").get("credential:openai") as {
    data: string;
  };
  const stored = JSON.parse(row.data);
  const replacement = crypto.randomUUID();
  stored.credentialId = replacement;
  f.sql.exec("UPDATE ui_state SET data=? WHERE key=?", JSON.stringify(stored), "credential:openai");
  await assert.rejects(
    f.vault.readLease(metadata.capability, replacement),
    /^Error: invalid_credential$/,
  );
});

test("stale form generation protects persistence but cannot activate a new generation", async () => {
  const f = fixture();
  form(f);
  const protectedUpdate = await protectTelegramCredentialUpdate(update(), f.sql, master);
  f.sql.exec("INSERT INTO ui_state VALUES(?,?)", "update:42", JSON.stringify(protectedUpdate));
  assert.equal(f.dump().includes(secret), false);
  assert.ok(protectedUpdate.credentialInput);
  await assert.rejects(
    readCredentialInput(protectedUpdate, master, { ...context, generation: 4 }),
    /^Error: invalid_credential_input$/,
  );
});

test("General thread one uses the zero-thread credential form scope", async () => {
  const f = fixture();
  f.sql.exec(
    "INSERT INTO ui_state VALUES(?,?)",
    "form:7:-100:0",
    JSON.stringify({
      kind: "credential",
      providerId: "openai",
      generation: 0,
      expires: Date.now() + 60000,
    }),
  );
  const general = update();
  general.message!.message_thread_id = 1;
  const protectedUpdate = await protectTelegramCredentialUpdate(general, f.sql, master);
  assert.equal(JSON.stringify(protectedUpdate).includes(secret), false);
  assert.equal(protectedUpdate.message?.message_thread_id, 1);
  assert.equal(protectedUpdate.credentialInput?.thread, 0);
  assert.equal(
    await readCredentialInput(protectedUpdate, master, { ...context, thread: 0, generation: 0 }),
    secret,
  );
});

test("credential captions are protected before durable update persistence", async () => {
  const f = fixture();
  form(f);
  const original = update();
  delete original.message!.text;
  original.message!.caption = secret;
  original.message!.document = { file_id: "file" };
  const result = await protectTelegramCredentialUpdate(original, f.sql, master);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(await readCredentialInput(result, master, context), secret);
});

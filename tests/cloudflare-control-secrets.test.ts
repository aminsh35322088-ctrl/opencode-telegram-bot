import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { resolveControlSecrets } from "../src/cloudflare/control-secrets.js";
import { decryptCredential, encryptCredential } from "../src/cloudflare/credentials.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (q: string, ...args: unknown[]) => db.prepare(q).all(...(args as never[])) as never,
  };
  new ControlStore(sql, (f) => f());
  const env = { TELEGRAM_BOT_TOKEN: "synthetic-bot", RAILWAY_API_TOKEN: "synthetic-railway" };
  return { db, sql, env };
}
test("only three user secrets generate persistent internal identity with encrypted storage", async () => {
  const f = fixture();
  const a = await resolveControlSecrets(f.sql, f.env);
  const b = await resolveControlSecrets(f.sql, f.env);
  assert.deepEqual(a, b);
  assert.equal(atob(a.CREDENTIAL_MASTER_KEY).length, 32);
  assert.ok(a.ADMIN_TOKEN.length >= 48);
  const row = f.db.prepare("SELECT data FROM control_secrets").get() as { data: string };
  for (const secret of [...Object.values(a), ...Object.values(f.env)])
    assert.ok(!row.data.includes(secret));
});
test("legacy credentials survive removal of extra Cloudflare secret bindings", async () => {
  const f = fixture();
  const legacy = {
    CREDENTIAL_MASTER_KEY: btoa("k".repeat(32)),
    ADMIN_TOKEN: "old-admin",
    TELEGRAM_WEBHOOK_SECRET: "old-webhook",
  };
  const blob = await encryptCredential(
    legacy.CREDENTIAL_MASTER_KEY,
    "worker:one",
    "node-owned-key",
  );
  assert.deepEqual(await resolveControlSecrets(f.sql, { ...f.env, ...legacy }), legacy);
  const migrated = await resolveControlSecrets(f.sql, f.env);
  assert.deepEqual(migrated, legacy);
  assert.equal(
    await decryptCredential(migrated.CREDENTIAL_MASTER_KEY, "worker:one", blob),
    "node-owned-key",
  );
});
test("single-token rotation rewraps without changing internal identities", async () => {
  const f = fixture();
  const original = await resolveControlSecrets(f.sql, f.env);
  const rotated = { ...f.env, RAILWAY_API_TOKEN: "new-synthetic-railway" };
  assert.deepEqual(await resolveControlSecrets(f.sql, rotated), original);
  assert.deepEqual(
    await resolveControlSecrets(f.sql, { ...rotated, TELEGRAM_BOT_TOKEN: "new-synthetic-bot" }),
    original,
  );
});
test("simultaneous token replacement and corrupted state fail closed without regeneration", async () => {
  const f = fixture();
  await resolveControlSecrets(f.sql, f.env);
  const before = f.db.prepare("SELECT data FROM control_secrets").get();
  await assert.rejects(
    resolveControlSecrets(f.sql, { TELEGRAM_BOT_TOKEN: "both-new", RAILWAY_API_TOKEN: "both-new" }),
    /control_secrets_unavailable/,
  );
  assert.deepEqual(f.db.prepare("SELECT data FROM control_secrets").get(), before);
  f.db.prepare("UPDATE control_secrets SET data='broken'").run();
  await assert.rejects(resolveControlSecrets(f.sql, f.env), /control_secrets_unavailable/);
  assert.equal(
    (f.db.prepare("SELECT data FROM control_secrets").get() as { data: string }).data,
    "broken",
  );
});
test("concurrent initialization cannot produce two control identities", async () => {
  const f = fixture();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => resolveControlSecrets(f.sql, f.env)),
  );
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(
    (f.db.prepare("SELECT COUNT(*) n FROM control_secrets").get() as { n: number }).n,
    1,
  );
});

test("canonical Control Plane migrates legacy secrets then authenticates with only three bindings", async () => {
  const { ControlPlane } = await import("../src/cloudflare/control-object.js");
  const { default: ingress } = await import("../src/cloudflare/worker.js");
  const f = fixture();
  const state = {
    storage: {
      sql: f.sql,
      transactionSync: <T>(action: () => T) => action(),
      setAlarm: async () => {},
    },
  };
  const legacy = {
    CREDENTIAL_MASTER_KEY: btoa("m".repeat(32)),
    ADMIN_TOKEN: "synthetic-admin",
    TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook",
  };
  const plane = new ControlPlane(state as never, { ...f.env, ...legacy } as never);
  assert.equal(
    (await plane.fetch(new Request("https://internal/admin/control-secrets"))).status,
    200,
  );
  const restarted = new ControlPlane(
    state as never,
    { ...f.env, TELEGRAM_ALLOWED_USER_ID: "7" } as never,
  );
  let mutations = 0;
  const env = {
    ...f.env,
    TELEGRAM_ALLOWED_USER_ID: "7",
    CONTROL: {
      getByName: () => ({
        fetch: async (url: string, init: RequestInit) => {
          if (!url.endsWith("/control/auth")) mutations++;
          return restarted.fetch(new Request(url, init));
        },
      }),
    },
  };
  const call = (token?: string) =>
    ingress.fetch(
      new Request("https://public/admin/inventory", {
        headers: token ? { Authorization: "Bearer " + token } : {},
      }),
      env as never,
    );
  assert.equal((await call()).status, 401);
  assert.equal((await call("wrong")).status, 401);
  assert.equal(mutations, 0);
  assert.equal((await call(legacy.ADMIN_TOKEN)).status, 200);
  assert.equal(mutations, 1);
  assert.equal(
    (
      await ingress.fetch(
        new Request("https://public/control/auth", { method: "POST", body: "{}" }),
        env as never,
      )
    ).status,
    404,
  );
  const health = await (
    await ingress.fetch(new Request("https://public/health"), env as never)
  ).json();
  assert.equal(health.provisioningEnabled, true);
  assert.equal(health.railwayCredentialPresent, true);
  assert.equal(
    (
      await restarted.fetch(
        new Request("https://internal/admin/setup", { method: "POST", body: "{}" }),
      )
    ).status,
    200,
  );
  const backend = JSON.parse(
    (f.db.prepare("SELECT data FROM backends").get() as { data: string }).data,
  );
  assert.equal(backend.desiredMaximumWorkers, 10);
  assert.equal(backend.maxWorkersPerProject, 5);
  assert.equal(backend.maxProjects, 2);
  assert.equal(backend.workspaceId, "df47876f-4c37-4a4d-89c7-407ec111227d");
});

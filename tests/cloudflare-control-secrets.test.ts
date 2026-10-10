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
test("changing the sole Telegram root fails closed instead of regenerating control identity", async () => {
  const f = fixture();
  await resolveControlSecrets(f.sql, f.env);
  const before = f.db.prepare("SELECT data FROM control_secrets").get();
  await assert.rejects(
    resolveControlSecrets(f.sql, { TELEGRAM_BOT_TOKEN: "new-synthetic-bot" }),
    /control_secrets_unavailable/,
  );
  assert.deepEqual(f.db.prepare("SELECT data FROM control_secrets").get(), before);
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
  assert.equal("railwayCredentialPresent" in health, false);
  const setupWithoutUserRailwayCredential = await restarted.fetch(
    new Request("https://internal/admin/setup", { method: "POST", body: "{}" }),
  );
  assert.equal(setupWithoutUserRailwayCredential.status, 409);
  assert.match(await setupWithoutUserRailwayCredential.text(), /railway_backend_not_configured/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM backends").get().n, 0);
});

test("missing internal identity never authenticates a literal undefined administrative token", async () => {
  const { ControlPlane } = await import("../src/cloudflare/control-object.js");
  const f = fixture();
  const plane = new ControlPlane(
    {
      storage: { sql: f.sql, transactionSync: <T>(f: () => T) => f(), setAlarm: async () => {} },
    } as never,
    {} as never,
  );
  const response = await plane.fetch(
    new Request("https://internal/control/auth", {
      method: "POST",
      body: JSON.stringify({ kind: "admin", supplied: "Bearer undefined" }),
    }),
  );
  assert.deepEqual(await response.json(), { authorized: false });
});

test("control secrets initialize and recover with Telegram as the only root binding", async () => {
  const f = fixture();
  const telegramOnly = { TELEGRAM_BOT_TOKEN: f.env.TELEGRAM_BOT_TOKEN };
  const first = await resolveControlSecrets(f.sql, telegramOnly);
  const second = await resolveControlSecrets(f.sql, telegramOnly);
  assert.deepEqual(second, first);
  const stored = JSON.parse((f.db.prepare("SELECT data FROM control_secrets").get() as { data: string }).data) as {
    version: number;
    telegram?: string;
    railway?: string;
  };
  assert.equal(stored.version, 2);
  assert.equal(typeof stored.telegram, "string");
  assert.equal(stored.railway, undefined);
});

test("legacy dual-envelope control secrets migrate through the Telegram envelope without Railway binding", async () => {
  const f = fixture();
  const legacy = await resolveControlSecrets(f.sql, f.env);
  const migrated = await resolveControlSecrets(f.sql, { TELEGRAM_BOT_TOKEN: f.env.TELEGRAM_BOT_TOKEN });
  assert.deepEqual(migrated, legacy);
  const stored = JSON.parse((f.db.prepare("SELECT data FROM control_secrets").get() as { data: string }).data) as {
    version: number;
    railway?: string;
  };
  assert.equal(stored.version, 2);
  assert.equal(stored.railway, undefined);
});

test("public and admin Control Plane contracts do not advertise a Railway Cloudflare binding", async () => {
  const { ControlPlane } = await import("../src/cloudflare/control-object.js");
  const { default: ingress } = await import("../src/cloudflare/worker.js");
  const health = (await (
    await ingress.fetch(
      new Request("https://public/health"),
      { TELEGRAM_BOT_TOKEN: "synthetic-bot", PROVISIONING_ENABLED: "true" } as never,
    )
  ).json()) as Record<string, unknown>;
  assert.equal("railwayCredentialPresent" in health, false);

  const f = fixture();
  const plane = new ControlPlane(
    {
      storage: { sql: f.sql, transactionSync: <T>(action: () => T) => action(), setAlarm: async () => {} },
    } as never,
    {
      TELEGRAM_BOT_TOKEN: f.env.TELEGRAM_BOT_TOKEN,
      CREDENTIAL_MASTER_KEY: btoa("q".repeat(32)),
      ADMIN_TOKEN: "synthetic-admin",
      TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook",
    } as never,
  );
  const contract = (await (
    await plane.fetch(new Request("https://internal/admin/control-secrets"))
  ).json()) as { userSecrets: string[] };
  assert.deepEqual(contract.userSecrets, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"]);
});

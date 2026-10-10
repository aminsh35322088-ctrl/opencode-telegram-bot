import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CapabilityRegistry, CloudCapabilityBroker } from "../src/cloudflare/capability-broker.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ui_state(key TEXT PRIMARY KEY,data TEXT NOT NULL)");
  const sql = { exec: (q: string, ...args: any[]) => db.prepare(q).all(...args) as never };
  const registry = new CapabilityRegistry();
  registry.register({
    id: "mock.database",
    credentialType: "api-token",
    capabilities: ["database.query"],
    requiredScopes: { "database.query": ["database:sample"] },
    runtime: "core",
    persistentState: false,
    processLifecycle: true,
  });
  const owner = {
    workerId: "worker-one",
    topicId: "-100:42",
    generation: 3,
    sessionId: "session-one",
  };
  let active = true;
  let now = 1000;
  const grants: any[] = [];
  const broker = new CloudCapabilityBroker(
    sql,
    btoa("k".repeat(32)),
    registry,
    () => (active ? { ...owner, grants } : undefined),
    () => now,
  );
  return {
    broker,
    registry,
    owner,
    grants,
    db,
    sql,
    retire: () => {
      active = false;
    },
    advance: () => {
      now += 60001;
    },
    dump: () =>
      JSON.stringify([
        ...db.prepare("SELECT * FROM ui_state").all(),
        ...(db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capability_leases'")
          .get()
          ? db.prepare("SELECT * FROM capability_leases").all()
          : []),
      ]),
  };
}
async function setup() {
  const f = fixture();
  const reference = await f.broker.save("mock.database", "fixture-secret", ["database:sample"]);
  f.grants.push({ ...reference, capabilities: ["database.query"], scopes: ["database:sample"] });
  const request = {
    ...f.owner,
    integrationId: "mock.database",
    credentialId: reference.credentialId,
    capability: "database.query",
    scopes: ["database:sample"],
  };
  return { ...f, reference, request };
}
test("generic mock integration leases encrypted material without persisting lease secrets", async () => {
  const f = await setup();
  const lease = await f.broker.acquire(f.owner, f.request);
  assert.equal(lease.value, "fixture-secret");
  assert.equal(f.broker.validate(f.owner, lease.leaseId).valid, true);
  assert.equal(f.dump().includes("fixture-secret"), false);
  assert.equal(JSON.stringify(f.reference).includes("fixture-secret"), false);
  f.broker.release(f.owner, lease.leaseId);
  assert.throws(() => f.broker.validate(f.owner, lease.leaseId), /credential_lease_rejected/);
  f.db.close();
});

test("lease expiration uses a dedicated compact table and never indexes general UI history", () => {
  const f = fixture();
  assert.equal(
    f.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capability_leases'")
      .all().length,
    1,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ui_state' AND name LIKE 'capability_%'",
      )
      .all().length,
    0,
  );
  const plan = f.db
    .prepare("EXPLAIN QUERY PLAN DELETE FROM capability_leases WHERE expires<=?")
    .all(1000) as { detail: string }[];
  assert.equal(
    plan.some((row) => /SEARCH capability_leases.*expires/.test(row.detail)),
    true,
    JSON.stringify(plan),
  );
});
test("privileged migration preserves references and cannot overwrite a credential", async () => {
  const f = fixture();
  const id = crypto.randomUUID();
  const reference = await f.broker.save(
    "mock.database",
    "migrated-secret",
    ["database:sample"],
    id,
  );
  assert.equal(reference.credentialId, id);
  await assert.rejects(
    f.broker.save("mock.database", "other-secret", ["database:sample"], id),
    /invalid_credential/,
  );
  assert.equal(await f.broker.readAccount("mock.database", id), "migrated-secret");
  assert.equal(f.dump().includes("migrated-secret"), false);
  f.db.close();
});
test("exact Worker Topic generation integration capability and scope authorization", async () => {
  const f = await setup();
  for (const changed of [
    { workerId: "other" },
    { topicId: "-100:43" },
    { generation: 2 },
    { integrationId: "github" },
    { capability: "database.delete" },
    { scopes: ["database:other"] },
    { credentialId: crypto.randomUUID() },
    { scopes: [] },
  ]) {
    await assert.rejects(
      f.broker.acquire(f.owner, { ...f.request, ...changed }),
      /credential_scope_rejected/,
    );
  }
  f.retire();
  await assert.rejects(f.broker.acquire(f.owner, f.request), /credential_scope_rejected/);
  f.db.close();
});
test("secretless capability authorization shares fencing and never decrypts or returns material", async () => {
  const f = await setup();
  const result = f.broker.authorize(f.owner, f.request);
  assert.deepEqual(result, { authorized: true, expiresAt: 61000 });
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  assert.equal(f.dump().includes("capability-lease:"), false);
  f.broker.remove(f.reference.credentialId);
  assert.throws(() => f.broker.authorize(f.owner, f.request), /credential_scope_rejected/);
  f.db.close();
});
test("expiration retirement generation replacement and revocation invalidate issued leases", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof setup>>) => f.advance(),
    (f: Awaited<ReturnType<typeof setup>>) => f.retire(),
    (f: Awaited<ReturnType<typeof setup>>) => {
      f.owner.generation++;
    },
    (f: Awaited<ReturnType<typeof setup>>) => f.broker.remove(f.reference.credentialId),
  ]) {
    const f = await setup();
    const original = { ...f.owner };
    const lease = await f.broker.acquire(original, f.request);
    mutate(f);
    assert.throws(() => f.broker.validate(original, lease.leaseId), /credential_lease_rejected/);
    f.db.close();
  }
});
test("rotation invalidates old leases and references, failed rotation preserves credential", async () => {
  const f = await setup();
  const lease = await f.broker.acquire(f.owner, f.request);
  await assert.rejects(
    f.broker.rotate(f.reference.credentialId, "bad\nsecret"),
    /invalid_credential/,
  );
  assert.equal(f.broker.validate(f.owner, lease.leaseId).valid, true);
  const next = await f.broker.rotate(f.reference.credentialId, "rotated-secret");
  assert.throws(() => f.broker.validate(f.owner, lease.leaseId), /credential_lease_rejected/);
  await assert.rejects(f.broker.acquire(f.owner, f.request), /credential_scope_rejected/);
  assert.equal(next.integrationId, "mock.database");
  assert.equal(f.dump().includes("rotated-secret"), false);
  f.db.close();
});
test("authority changed while encryption awaits cannot receive material", async () => {
  const f = await setup();
  const pending = f.broker.acquire(f.owner, f.request);
  f.retire();
  await assert.rejects(pending, /credential_scope_rejected/);
  f.db.close();
});
test("registry refuses duplicate and malformed declarations", () => {
  const f = fixture();
  assert.throws(() =>
    f.registry.register({ id: "mock.database", capabilities: ["database.query"] } as never),
  );
  assert.throws(() => f.registry.register({ id: "bad id", capabilities: [] } as never));
  f.db.close();
});

test("credential request cannot persist arbitrary secret fields as audit metadata", async () => {
  const f = await setup();
  await assert.rejects(
    f.broker.acquire(f.owner, { ...f.request, token: "unsafe-extra-secret" } as never),
    /credential_scope_rejected/,
  );
  assert.equal(f.dump().includes("unsafe-extra-secret"), false);
  f.db.close();
});

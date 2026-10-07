import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type SqlDatabase } from "../src/cloudflare/control-store.js";
import { encryptCredential, decryptCredential } from "../src/cloudflare/credentials.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...bindings) as never,
  };
  const transaction = <T>(action: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    sql,
    transaction,
    store: new ControlStore(sql, transaction),
    restart: () => new ControlStore(sql, transaction),
  };
}
function backend(store: ControlStore, id = "a", maximum = 10, perProject = 5) {
  store.putBackend({
    backendId: id,
    workspaceId: "workspace-" + id,
    credential: "encrypted-reference",
    region: "europe-west4",
    desiredMaximumWorkers: maximum,
    maxWorkersPerProject: perProject,
    enabled: true,
  });
}

test("zero-project New Chat reserves lazy capacity without creating a writable Topic", () => {
  const { store } = fixture();
  backend(store);
  const job = store.reserveAllocation("update-1", -100);
  assert.equal(job.backendId, "a");
  assert.equal(store.projects().length, 0);
  assert.equal(store.workers().length, 1);
  assert.equal(store.topics().length, 0);
  assert.equal(job.phase, "PROVISIONING");
});
test("duplicate New Chat and restart preserve one allocation identity", () => {
  const f = fixture();
  backend(f.store);
  const first = f.store.reserveAllocation("same", -100);
  assert.equal(f.restart().reserveAllocation("same", -100).jobId, first.jobId);
  assert.equal(f.store.workers().length, 1);
});
test("five reservations fill a project and sixth reserves the next shard", () => {
  const { store } = fixture();
  backend(store);
  const jobs = [];
  for (let i = 0; i < 6; i++) {
    const job = store.reserveAllocation("u" + i, -100);
    jobs.push(job);
    store.selectProject(job.jobId);
  }
  assert.deepEqual(
    store.projects().map((p) => p.reservedWorkers),
    [5, 1],
  );
  assert.notEqual(store.job(jobs[0]!.jobId)!.projectKey, store.job(jobs[5]!.jobId)!.projectKey);
});
test("project capacity is configurable and backend maximum is enforced lazily", () => {
  const { store } = fixture();
  backend(store, "a", 3, 2);
  for (let i = 0; i < 3; i++) store.selectProject(store.reserveAllocation("u" + i, -100).jobId);
  assert.deepEqual(
    store.projects().map((p) => p.reservedWorkers),
    [2, 1],
  );
  assert.throws(() => store.reserveAllocation("extra", -100), /capacity_exhausted/);
});
test("multi-backend allocation uses eligible capacity and excludes disabled backends", () => {
  const { store } = fixture();
  backend(store, "a", 1);
  backend(store, "b", 2);
  assert.equal(store.reserveAllocation("a", -100).backendId, "a");
  assert.equal(store.reserveAllocation("b", -100).backendId, "b");
  store.putBackend({ ...store.backends().find((b) => b.backendId === "b")!, enabled: false });
  assert.throws(() => store.reserveAllocation("c", -100), /capacity_exhausted/);
});
test("bootstrap is short lived, service bound, and strictly one-time", () => {
  const { store } = fixture();
  backend(store);
  const job = store.reserveAllocation("boot", -100);
  store.configureJob(job.jobId, {
    serviceId: "service",
    projectId: "project",
    environmentId: "env",
    endpoint: "https://node.example",
    volumeId: "volume",
  });
  store.issueBootstrap(job.jobId, "token-hash", 1000);
  assert.throws(
    () => store.consumeBootstrap("token-hash", "other", "project", 900),
    /bootstrap_rejected/,
  );
  assert.equal(
    store.consumeBootstrap("token-hash", "service", "project", 900).workerId,
    job.workerId,
  );
  assert.throws(
    () => store.consumeBootstrap("token-hash", "service", "project", 900),
    /bootstrap_rejected/,
  );
});
test("expired bootstrap token cannot bind a Worker", () => {
  const { store } = fixture();
  backend(store);
  const job = store.reserveAllocation("boot", -100);
  store.configureJob(job.jobId, { serviceId: "s", projectId: "p" });
  store.issueBootstrap(job.jobId, "hash", 100);
  assert.throws(() => store.consumeBootstrap("hash", "s", "p", 101), /bootstrap_rejected/);
});
test("Topic binding requires ready authenticated Worker and is idempotent", () => {
  const { store } = fixture();
  backend(store);
  const job = store.reserveAllocation("bind", -100);
  assert.throws(() => store.bindTopic(job.jobId, 42, "session"), /worker_not_ready/);
  store.ready(job.workerId, job.generation, "encrypted-key");
  const topic = store.bindTopic(job.jobId, 42, "session");
  assert.equal(topic.workerId, job.workerId);
  assert.deepEqual(store.bindTopic(job.jobId, 42, "session"), topic);
  assert.equal(store.workers()[0]!.state, "BOUND_IDLE");
});
test("delete fences before cleanup and releases same Worker only after verified cleanup", () => {
  const { store } = fixture();
  backend(store);
  const job = store.reserveAllocation("bind", -100);
  store.ready(job.workerId, job.generation, "key");
  store.bindTopic(job.jobId, 42, "session");
  const fenced = store.fenceTopic(-100, 42);
  assert.equal(fenced.generation, job.generation + 1);
  assert.throws(
    () => store.admitEvent(job.workerId, job.generation, "nonce-1", 1, 1, "session"),
    /stale_generation/,
  );
  assert.notEqual(store.reserveAllocation("another", -100).workerId, job.workerId);
  store.completeCleanup(job.workerId, fenced.generation);
  const reused = store.reserveAllocation("reuse", -100);
  assert.equal(reused.workerId, job.workerId);
  assert.ok(reused.generation > fenced.generation);
});
test("stale and replayed Worker events are rejected durably", () => {
  const f = fixture();
  backend(f.store);
  const job = f.store.reserveAllocation("event", -100);
  f.store.ready(job.workerId, job.generation, "key");
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.admitEvent(job.workerId, job.generation, "nonce-1", 1000, 1000, "session");
  assert.throws(
    () => f.restart().admitEvent(job.workerId, job.generation, "nonce-1", 1000, 1000, "session"),
    /replay_rejected/,
  );
  assert.throws(
    () => f.store.admitEvent(job.workerId, job.generation, "nonce-2", 1000, 1000, "foreign"),
    /session_mismatch/,
  );
});
test("per-Topic queue persists order through restart and permits one active run", () => {
  const f = fixture();
  backend(f.store);
  const job = f.store.reserveAllocation("q", -100);
  f.store.ready(job.workerId, job.generation, "key");
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueue(-100, 42, "A", "a");
  f.store.enqueue(-100, 42, "B", "b");
  f.store.enqueue(-100, 42, "C", "c");
  assert.equal(f.restart().startNext(-100, 42)!.requestId, "A");
  assert.equal(f.store.startNext(-100, 42), undefined);
  f.store.finishRun(-100, 42, "A");
  assert.equal(f.restart().startNext(-100, 42)!.requestId, "B");
});
test("global reset advances revision and preserves previous valid snapshot on bad activation", () => {
  const f = fixture();
  assert.equal(f.store.setGlobal({ models: [] }, "hash-1").revision, 1);
  assert.equal(f.restart().setGlobal({ models: [] }, "hash-2").revision, 2);
  assert.throws(() => f.store.setGlobal({ models: [] }, ""), /invalid_snapshot/);
  assert.equal(f.store.global()!.revision, 2);
});
test("Railway credentials use authenticated encryption bound to backend identity", async () => {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const encrypted = await encryptCredential(key, "backend:a", "synthetic-railway-token");
  assert.equal(encrypted.includes("synthetic-railway-token"), false);
  assert.equal(await decryptCredential(key, "backend:a", encrypted), "synthetic-railway-token");
  await assert.rejects(decryptCredential(key, "backend:b", encrypted));
  await assert.rejects(decryptCredential(key, "backend:a", encrypted.slice(0, -3) + "abc"));
});
test("durable provisioning lease excludes concurrent jobs and can recover after expiry", () => {
  const f = fixture();
  assert.equal(f.store.acquireLease("railway", "owner-a", 100, 500), true);
  assert.equal(f.restart().acquireLease("railway", "owner-b", 101, 500), false);
  assert.equal(f.restart().acquireLease("railway", "owner-b", 601, 500), true);
  assert.throws(() => f.store.renewLease("railway", "owner-a", 602, 500), /lease_lost/);
  f.store.releaseLease("railway", "owner-b");
  assert.equal(f.store.acquireLease("railway", "owner-c", 603, 500), true);
});
test("snapshot publication rejects a revision changed during hashing", () => {
  const { store } = fixture();
  store.setGlobal({ version: 1, revision: 1 }, "hash-one", 0);
  assert.throws(
    () => store.setGlobal({ version: 1, revision: 1 }, "stale-hash", 0),
    /snapshot_revision_conflict/,
  );
  assert.equal(store.global()!.hash, "hash-one");
  assert.equal(store.global()!.data.revision, 1);
});
test("rotating a bootstrap token revokes the previous unconsumed token", () => {
  const { store } = fixture();
  backend(store);
  const job = store.reserveAllocation("rotate", -100);
  store.configureJob(job.jobId, { serviceId: "s", projectId: "p" });
  store.issueBootstrap(job.jobId, "old", 1000);
  store.issueBootstrap(job.jobId, "new", 1000);
  assert.throws(() => store.consumeBootstrap("old", "s", "p", 900), /bootstrap_rejected/);
  assert.equal(store.consumeBootstrap("new", "s", "p", 900).jobId, job.jobId);
});

test("durable update alarm rearms until all persisted batches drain", async () => {
  const { ControlPlane } = await import("../src/cloudflare/control-object.js");
  const f = fixture();
  let alarms = 0;
  const plane = new ControlPlane(
    {
      storage: {
        sql: f.sql,
        transactionSync: f.transaction,
        setAlarm: async () => {
          alarms++;
        },
      },
    } as never,
    { TELEGRAM_ALLOWED_USER_IDS: "7" } as never,
  );
  for (let i = 0; i < 41; i++)
    f.sql.exec(
      "INSERT INTO updates(id,data) VALUES(?,?)",
      i,
      JSON.stringify({
        update_id: i,
        message: { from: { id: 8 }, chat: { id: -100 }, text: "ignored" },
      }),
    );
  await plane.alarm();
  assert.equal(alarms, 1);
  await plane.alarm();
  assert.equal(alarms, 2);
  await plane.alarm();
  assert.equal([...f.sql.exec("SELECT id FROM updates WHERE state='PENDING'")].length, 0);
});
test("backend enforces a separate maximum project count before reserving another shard", () => {
  const f = fixture();
  backend(f.store, "limited", 10, 1);
  f.store.putBackend({ ...f.store.backends()[0]!, maxProjects: 2 } as never);
  f.store.selectProject(f.store.reserveAllocation("one", -100).jobId);
  f.store.selectProject(f.store.reserveAllocation("two", -100).jobId);
  const third = f.store.reserveAllocation("three", -100);
  assert.throws(() => f.store.selectProject(third.jobId), /project_capacity_exhausted/);
  assert.equal(f.store.projects().length, 2);
});
test("confirmed infrastructure deletion removes binding and releases project reservation", () => {
  const f = fixture();
  backend(f.store);
  const job = f.store.reserveAllocation("destroy", -100);
  f.store.selectProject(job.jobId);
  f.store.ready(job.workerId, 1, "key");
  f.store.bindTopic(job.jobId, 42, "session");
  const fenced = f.store.fenceTopic(-100, 42);
  assert.throws(() => f.store.confirmDestroyed(job.workerId, 1), /stale_generation/);
  f.store.confirmDestroyed(job.workerId, fenced.generation);
  assert.equal(f.store.topics().length, 0);
  assert.equal(f.store.projects()[0]!.reservedWorkers, 0);
  assert.equal(f.store.worker(job.workerId)!.state, "REPLACED");
});

test("signed callbacks survive restart, deduplicate and reject another run", () => {
  const f = fixture();
  backend(f.store);
  const job = f.store.reserveAllocation("callback", -100);
  f.store.ready(job.workerId, job.generation, "key");
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueue(-100, 42, "run1", "hello");
  f.store.startNext(-100, 42);
  const payload = {
    runId: "run1",
    streamNonce: "stream",
    sequence: 1,
    event: {
      type: "message.part.updated",
      properties: { part: { id: "part1", type: "text", text: "سلام" } },
    },
  };
  assert.equal(f.store.recordCallback(-100, 42, payload), true);
  assert.equal(f.restart().recordCallback(-100, 42, payload), false);
  assert.throws(
    () => f.store.recordCallback(-100, 42, { ...payload, runId: "foreign" }),
    /run_mismatch/,
  );
  f.store.recordCallback(-100, 42, {
    ...payload,
    sequence: 2,
    event: { type: "session.idle", properties: {} },
  });
  assert.equal(f.restart().completedResponses()[0]?.text, "سلام");
  assert.equal(f.store.startNext(-100, 42), undefined);
});

test("different retry identities cannot reserve the same Topic twice", () => {
  const f = fixture();
  backend(f.store);
  const first = f.store.reserveTopicAllocation("first", -100, 42);
  assert.equal(f.restart().reserveTopicAllocation("different", -100, 42).jobId, first.jobId);
  assert.equal(f.store.workers().length, 1);
});

test("only assistant parts are rendered into the terminal Telegram response", () => {
  const f = fixture();
  backend(f.store);
  const job = f.store.reserveAllocation("role", -100);
  f.store.ready(job.workerId, 1, "key");
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueue(-100, 42, "roles", "prompt");
  f.store.startNext(-100, 42);
  let sequence = 0;
  const send = (event: unknown) =>
    f.store.recordCallback(-100, 42, {
      runId: "roles",
      streamNonce: "stream",
      sequence: ++sequence,
      event,
    });
  send({ type: "message.updated", properties: { info: { id: "u", role: "user" } } });
  send({
    type: "message.part.updated",
    properties: { part: { id: "up", messageID: "u", type: "text", text: "prompt" } },
  });
  send({ type: "message.updated", properties: { info: { id: "a", role: "assistant" } } });
  send({
    type: "message.part.updated",
    properties: { part: { id: "ap", messageID: "a", type: "text", text: "answer" } },
  });
  send({ type: "session.idle", properties: {} });
  assert.equal(f.store.completedResponses()[0]?.text, "answer");
});

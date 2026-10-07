import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { encryptCredential } from "../src/cloudflare/credentials.js";
import { signEnvelope } from "../src/cloudflare/protocol.js";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { ControlPlane } from "../src/cloudflare/control-object.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (q: string, ...args: unknown[]) => db.prepare(q).all(...(args as never[])) as never,
  };
  const tx = <T>(f: () => T): T => {
    db.exec("BEGIN");
    try {
      const r = f();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const queued: unknown[] = [];
  const env = {
    TELEGRAM_BOT_TOKEN: "synthetic-telegram",
    RAILWAY_API_TOKEN: "synthetic-provisioning-secret",
    RAILWAY_WORKSPACE_ID: "workspace",
    MAX_WORKERS: "10",
    WORKERS_PER_PROJECT: "5",
    MAX_RAILWAY_PROJECTS: "2",
    PROVISION_ON_TOPIC_CREATE: "true",
    TELEGRAM_ALLOWED_USER_ID: "7",
    CREDENTIAL_MASTER_KEY: btoa("k".repeat(32)),
    JOBS: {
      send: async (x: unknown) => {
        queued.push(x);
      },
    },
  };
  const plane = new ControlPlane(
    { storage: { sql, transactionSync: tx, setAlarm: async () => {} } } as never,
    env as never,
  );
  return { plane, sql, queued, store: new ControlStore(sql, tx) };
}
const post = (plane: ControlPlane, path: string, body: unknown = {}) =>
  plane.fetch(
    new Request("https://internal" + path, { method: "POST", body: JSON.stringify(body) }),
  );
test("production setup stores only secret reference and preserves lazy zero-project inventory", async () => {
  const f = fixture();
  const response = await post(f.plane, "/admin/setup");
  assert.equal(response.status, 200);
  const rows = [...f.sql.exec("SELECT data FROM backends")] as Array<{ data: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.data.includes("synthetic-provisioning-secret"), false);
  assert.equal(JSON.parse(rows[0]!.data).credential, "binding:RAILWAY_API_TOKEN");
  assert.equal(([...f.sql.exec("SELECT id FROM projects")] as unknown[]).length, 0);
});
test("equivalent Topic create request allocates once and never activates an unready Worker", async () => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const body = { requestId: "canary", chatId: -100, threadId: 42 };
  const a = await (await post(f.plane, "/admin/topics", body)).json();
  const b = await (await post(f.plane, "/admin/topics", body)).json();
  assert.equal(a.workerId, b.workerId);
  assert.equal(a.jobId, b.jobId);
  assert.equal(([...f.sql.exec("SELECT worker FROM topics")] as unknown[]).length, 0);
});
test("General Topic admission rejects before reserving infrastructure", async () => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  assert.equal(
    (await post(f.plane, "/admin/topics", { requestId: "general", chatId: -100, threadId: 1 }))
      .status,
    409,
  );
  assert.equal(([...f.sql.exec("SELECT id FROM workers")] as unknown[]).length, 0);
});

test("Telegram chunk retry preserves already delivered chunks", async (t) => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveAllocation("delivery", -100);
  f.store.ready(job.workerId, 1, "key");
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueue(-100, 42, "delivery", "prompt");
  f.store.startNext(-100, 42);
  f.store.recordCallback(-100, 42, {
    runId: "delivery",
    streamNonce: "s",
    sequence: 1,
    event: {
      type: "message.part.updated",
      properties: { part: { id: "text", type: "text", text: "x".repeat(40000) } },
    },
  });
  f.store.recordCallback(-100, 42, {
    runId: "delivery",
    streamNonce: "s",
    sequence: 2,
    event: { type: "session.idle", properties: {} },
  });
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 2
      ? Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: 1 } },
          { status: 429 },
        )
      : Response.json({ ok: true, result: { message_id: calls } });
  };
  await f.plane.alarm();
  assert.equal(calls, 2);
  await f.plane.alarm();
  assert.equal(calls, 3);
  assert.equal(f.store.completedResponses().length, 0);
});

test("uncertain admission reaches owned stop and terminal failure instead of retrying forever", async (t) => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveTopicAllocation("uncertain", -100, 42);
  const secret = "n".repeat(64),
    credential = await encryptCredential(
      btoa("k".repeat(32)),
      "node:" + job.workerId + ":1",
      secret,
    );
  f.store.configureJob(job.jobId, { endpoint: "https://canary.up.railway.app" });
  f.store.ready(job.workerId, 1, credential);
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueue(-100, 42, "uncertain", "prompt");
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const operations: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("api.telegram.org"))
      return Response.json({ ok: true, result: { message_id: 1 } });
    const envelope = JSON.parse(String(init?.body));
    operations.push(envelope.operation);
    assert.equal(envelope.sessionId, "session");
    const result =
      envelope.operation === "run"
        ? { accepted: false }
        : envelope.operation === "callback.status"
          ? { state: "SUBMITTED" }
          : null;
    const signed = await signEnvelope(
      {
        ...envelope,
        nonce: crypto.randomUUID(),
        timestamp: Date.now(),
        payload: { ok: true, result },
      },
      secret,
    );
    return new Response(signed.body, { headers: { "x-node-signature": signed.signature } });
  };
  await f.plane.alarm();
  assert.deepEqual(operations, ["run", "callback.status", "stop", "status"]);
  assert.equal(f.store.activeRuns(-100, 42).length, 0);
  assert.equal(
    (
      [...f.sql.exec("SELECT state FROM runs WHERE request='uncertain'")] as Array<{
        state: string;
      }>
    )[0]?.state,
    "FAILED",
  );
});

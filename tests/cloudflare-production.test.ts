import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { encryptCredential } from "../src/cloudflare/credentials.js";
import { signEnvelope } from "../src/cloudflare/protocol.js";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { ControlPlane } from "../src/cloudflare/control-object.js";
import {
  protectTelegramCredentialUpdate,
  type ProtectedTelegramUpdate,
} from "../src/cloudflare/credential-vault.js";
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
  let alarmAt: number | null = null;
  const env = {
    TELEGRAM_BOT_TOKEN: "synthetic-telegram",
    RAILWAY_API_TOKEN: "synthetic-provisioning-secret",
    RAILWAY_WORKSPACE_ID: "workspace",
    MAX_WORKERS: "10",
    WORKERS_PER_PROJECT: "5",
    MAX_RAILWAY_PROJECTS: "2",
    PROVISION_ON_TOPIC_CREATE: "true",
    PROVISIONING_ENABLED: "true",
    TELEGRAM_ALLOWED_USER_ID: "7",
    CREDENTIAL_MASTER_KEY: btoa("k".repeat(32)),
    JOBS: {
      send: async (x: unknown) => {
        queued.push(x);
      },
    },
  };
  const plane = new ControlPlane(
    {
      storage: {
        sql,
        transactionSync: tx,
        getAlarm: async () => alarmAt,
        setAlarm: async (value: number) => {
          alarmAt = value;
        },
      },
    } as never,
    env as never,
  );
  return { plane, sql, queued, getAlarm: () => alarmAt, store: new ControlStore(sql, tx) };
}
const post = (plane: ControlPlane, path: string, body: unknown = {}) =>
  plane.fetch(
    new Request("https://internal" + path, { method: "POST", body: JSON.stringify(body) }),
  );

async function tokenHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("initial Worker bootstrap is strictly unbound 0/0 even though the allocation knows its Telegram chat", async () => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveAllocation("bootstrap-unbound", -100);
  f.store.configureJob(job.jobId, { serviceId: "service", projectId: "project", environmentId: "env" });
  const token = "bootstrap-token";
  f.store.issueBootstrap(job.jobId, await tokenHash(token), Date.now() + 60_000);
  const response = await post(f.plane, "/nodes/bootstrap", {
    bootstrapToken: token,
    serviceId: "service",
    projectId: "project",
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { identity: { nodeId: string; generation: number; chatId: number; threadId: number } };
  assert.deepEqual(body.identity, {
    nodeId: job.workerId,
    generation: 1,
    chatId: 0,
    threadId: 0,
  });
});

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
      properties: {
        part: {
          id: "text",
          type: "text",
          text: "First chunk boundary marker\n\n" + "x".repeat(40000),
        },
      },
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
  const attempts: string[] = [];
  let keyboardCalls = 0;
  globalThis.fetch = async (input, init) => {
    const payload = JSON.parse(String(init?.body));
    if (
      (String(input).endsWith("/sendMessage") || String(input).endsWith("/editMessageText")) &&
      (payload.reply_markup?.keyboard ||
        payload.reply_markup?.inline_keyboard ||
        payload.reply_markup?.remove_keyboard)
    ) {
      keyboardCalls++;
      return Response.json({ ok: true, result: { message_id: 100 } });
    }
    calls++;
    attempts.push(JSON.stringify(payload));
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
  const chunks = [
    ...f.sql.exec<{ state: string }>(
      "SELECT state FROM outbox WHERE id LIKE ? AND id NOT LIKE ?",
      "delivery:%",
      "%:diff",
    ),
  ];
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.state === "DELIVERED"));
  assert.equal(calls, chunks.length + 1);
  assert.equal(attempts.filter((payload) => payload === attempts[0]).length, 1);
  // Native Stop owns run control; start/finalization must not spam ReplyKeyboard refreshes.
  assert.equal(keyboardCalls, 0);
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

test("admin canary and webhook share idempotent Topic creation", async (t) => {
  const f = fixture(),
    original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let creates = 0;
  globalThis.fetch = async () => {
    creates++;
    return Response.json({ ok: true, result: { message_thread_id: 42 } });
  };
  const body = { chatId: -100, requestId: "canary_new" };
  const a = await (await post(f.plane, "/admin/new-topic", body)).json();
  const b = await (await post(f.plane, "/admin/new-topic", body)).json();
  assert.equal(creates, 0);
  assert.equal(a.jobId, b.jobId);
  assert.equal(a.threadId, undefined);
  assert.equal(f.store.workers().length, 1);
  assert.equal(f.store.topics().length, 0);
});

test("text deltas append exactly once and retain assistant ownership", async () => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveAllocation("delta", -100);
  f.store.ready(job.workerId, 1, "key");
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueue(-100, 42, "delta", "prompt");
  f.store.startNext(-100, 42);
  const send = (sequence: number, event: unknown) =>
    f.store.recordCallback(-100, 42, { runId: "delta", streamNonce: "stream", sequence, event });
  send(1, {
    type: "message.updated",
    properties: { info: { id: "assistant", role: "assistant" } },
  });
  send(2, {
    type: "message.part.updated",
    properties: { part: { id: "part", type: "text", text: "", messageID: "assistant" } },
  });
  const event = {
    type: "message.part.delta",
    properties: { partID: "part", messageID: "assistant", field: "text", delta: "Hello" },
  };
  assert.equal(send(3, event), true);
  assert.equal(send(3, event), false);
  send(4, { type: "session.idle", properties: {} });
  assert.equal(f.store.completedResponses()[0]?.text, "Hello");
});

test("cancel-job resumes deletion after a lost cleanup response without refencing", async () => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveAllocation("cancel-retry", -100);
  f.store.configureJob(job.jobId, { phase: "VOLUME_CREATING" });
  let attempts = 0;
  (f.plane as unknown as { driver: () => unknown }).driver = () => ({
    destroy: async () => {
      if (++attempts === 1) throw new Error("cleanup_pending");
    },
  });
  assert.equal((await post(f.plane, "/admin/cancel-job", { jobId: job.jobId })).status, 409);
  const generation = f.store.worker(job.workerId)!.generation;
  assert.equal(f.store.job(job.jobId)?.cleanupPhase, "VOLUME_CREATING");
  assert.equal((await post(f.plane, "/admin/cancel-job", { jobId: job.jobId })).status, 200);
  assert.equal(f.store.worker(job.workerId)?.generation, generation);
  assert.equal(f.store.worker(job.workerId)?.state, "REPLACED");
  assert.equal((await post(f.plane, "/admin/cancel-job", { jobId: job.jobId })).status, 200);
  assert.equal(attempts, 2);
});

test("cancelling a timed-out job preserves an ambiguous volume creation receipt", async () => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveAllocation("cancel-timeout", -100);
  f.store.configureJob(job.jobId, {
    phase: "FAILED",
    error: "provisioning_deadline_exceeded",
    cleanupPhase: "VOLUME_CREATING",
  });
  (f.plane as unknown as { driver: () => unknown }).driver = () => ({
    destroy: async () => {
      throw new Error("volume_creation_reconciliation_required");
    },
  });
  assert.equal((await post(f.plane, "/admin/cancel-job", { jobId: job.jobId })).status, 409);
  assert.equal(f.store.job(job.jobId)?.cleanupPhase, "VOLUME_CREATING");
  assert.equal(f.store.worker(job.workerId)?.state, "DELETING");
});

test("changing global configuration does not unlock an already admitted run", async (t) => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveTopicAllocation("pin-active", -100, 42),
    secret = "n".repeat(64);
  const credential = await encryptCredential(
    btoa("k".repeat(32)),
    "node:" + job.workerId + ":1",
    secret,
  );
  f.store.configureJob(job.jobId, { endpoint: "https://canary.up.railway.app" });
  f.store.ready(job.workerId, 1, credential);
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueueVerified(-100, 42, "pin-active", "prompt", 1, 1, "opencode/big-pickle");
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const expectedRevisions: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const envelope = JSON.parse(String(init?.body));
    if (envelope.operation === "run") expectedRevisions.push(envelope.payload.expectedRevision);
    const result = envelope.operation === "run" ? { accepted: true } : { state: "ACCEPTED" };
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
  await post(f.plane, "/admin/global", {
    configuration: { runtime: { model: "other/model" } },
    skills: [],
    actions: [],
    catalog: {},
    defaults: {},
    credentialReferences: [],
  });
  await f.plane.alarm();
  // Accepted turns remain pinned without being submitted again for each stream wake.
  assert.deepEqual(expectedRevisions, [1]);
  assert.equal(f.store.runPin("pin-active")?.revision, 1);
  assert.equal(f.store.runPin("pin-active")?.model, "opencode/big-pickle");
  assert.equal(f.store.runPin("pin-active")?.dispatched, 1);
  assert.equal(f.store.activeRuns(-100, 42).length, 1);
});

test("authenticated pre-admission revision rejection releases queue only after verified inactivity", async (t) => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveTopicAllocation("revision-rejected", -100, 42),
    secret = "n".repeat(64);
  const credential = await encryptCredential(
    btoa("k".repeat(32)),
    "node:" + job.workerId + ":1",
    secret,
  );
  f.store.configureJob(job.jobId, { endpoint: "https://canary.up.railway.app" });
  f.store.ready(job.workerId, 1, credential);
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueueVerified(-100, 42, "revision-rejected", "prompt", 1, 1, "opencode/big-pickle");
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
    const rejected = envelope.operation === "run";
    const signed = await signEnvelope(
      {
        ...envelope,
        nonce: crypto.randomUUID(),
        timestamp: Date.now(),
        payload: rejected ? { ok: false, error: "operation rejected" } : { ok: true, result: null },
      },
      secret,
    );
    return new Response(signed.body, {
      status: rejected ? 409 : 200,
      headers: { "x-node-signature": signed.signature },
    });
  };
  await f.plane.alarm();
  assert.deepEqual(operations, ["run", "status"]);
  assert.equal(f.store.activeRuns(-100, 42).length, 0);
  assert.equal(
    (
      [...f.sql.exec("SELECT state FROM runs WHERE request='revision-rejected'")] as Array<{
        state: string;
      }>
    )[0]?.state,
    "FAILED",
  );
});

test("control restart resumes a volume attachment job from durable journal", async () => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveTopicAllocation("attach-restart", -100, 42);
  f.store.configureJob(job.jobId, { phase: "VOLUME_ATTACHING" });
  const resumed: string[] = [];
  (f.plane as unknown as { advance: (id: string) => Promise<void> }).advance = async (id) => {
    resumed.push(id);
  };
  await f.plane.alarm();
  assert.deepEqual(resumed, [job.jobId]);
});

test("run status reports scoped execution and delivery receipts without prompt or secrets", async () => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveAllocation("observe", -100);
  f.store.ready(job.workerId, 1, "synthetic-node-secret");
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueue(-100, 42, "observe", "synthetic-private-prompt");
  f.store.startNext(-100, 42);
  f.sql.exec(
    "INSERT INTO outbox VALUES(?,?,?)",
    "observe:0",
    JSON.stringify({ run: "observe", index: 0 }),
    "DELIVERED",
  );
  const response = await post(f.plane, "/admin/run-status", {
    chatId: -100,
    threadId: 42,
    requestId: "observe",
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.run.state, "ACTIVE");
  assert.deepEqual(data.delivery, [{ id: "observe:0", state: "DELIVERED" }]);
  assert.equal(JSON.stringify(data).includes("synthetic-private-prompt"), false);
  assert.equal(JSON.stringify(data).includes("synthetic-node-secret"), false);
  assert.equal(
    (await post(f.plane, "/admin/run-status", { chatId: -100, threadId: 43, requestId: "observe" }))
      .status,
    409,
  );
});

test("Telegram prompts require the same verified model and revision admission as canary prompts", async (t) => {
  for (const connected of [false, true]) {
    const f = fixture();
    await post(f.plane, "/admin/setup");
    await post(f.plane, "/admin/global", {
      configuration: { runtime: { model: "opencode/big-pickle" } },
      skills: [],
      actions: [],
      catalog: {},
      defaults: {},
      credentialReferences: [],
    });
    const job = f.store.reserveTopicAllocation("webhook-admission", -100, 42),
      secret = "n".repeat(64);
    const credential = await encryptCredential(
      btoa("k".repeat(32)),
      "node:" + job.workerId + ":1",
      secret,
    );
    f.store.configureJob(job.jobId, { endpoint: "https://canary.up.railway.app" });
    f.store.ready(job.workerId, 1, credential);
    f.store.bindTopic(job.jobId, 42, "session");
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
      const result = { available: true, connected };
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
    const update = {
      update_id: 901,
      message: { chat: { id: -100 }, from: { id: 7 }, message_thread_id: 42, text: "prompt" },
    };
    await post(f.plane, "/telegram/webhook", update);
    await post(f.plane, "/telegram/webhook", update);
    await f.plane.alarm();
    assert.deepEqual(operations, ["model.inspect"]);
    assert.equal([...f.sql.exec("SELECT request FROM runs")].length, connected ? 1 : 0);
    if (connected)
      assert.deepEqual(
        { ...f.store.runPin("telegram_901") },
        {
          generation: 1,
          revision: 2,
          model: "opencode/big-pickle",
          dispatched: 0,
        },
      );
    globalThis.fetch = original;
  }
});

test("Core compaction dispatch shares Topic queue and signed callback fencing without prompt fields", async (t) => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveTopicAllocation("compact-dispatch", -100, 42),
    secret = "c".repeat(64);
  f.store.configureJob(job.jobId, { endpoint: "https://canary.up.railway.app" });
  f.store.ready(
    job.workerId,
    1,
    await encryptCredential(btoa("k".repeat(32)), "node:" + job.workerId + ":1", secret),
  );
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.saveObservation(job.workerId, 1, { runtimeVersion: "1.18.33-bot.13-pre.25" });
  f.store.enqueueVerified(
    -100,
    42,
    "compact-run",
    "Context compaction",
    1,
    1,
    "opencode/big-pickle",
    "session.compact",
  );
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const received: any[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("api.telegram.org"))
      return Response.json({ ok: true, result: { message_id: 1 } });
    const envelope = JSON.parse(String(init?.body));
    received.push(envelope);
    const result =
      envelope.operation === "session.compact"
        ? { accepted: true }
        : envelope.operation === "callback.status"
          ? { state: "ACCEPTED" }
          : [];
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
  const compact = received.find((e) => e.operation === "session.compact");
  assert.ok(compact);
  assert.equal(compact.sessionId, "session");
  assert.equal(compact.generation, 1);
  assert.deepEqual(compact.payload, {
    runId: "compact-run",
    events: true,
    expectedRevision: 1,
    model: { providerID: "opencode", modelID: "big-pickle" },
  });
  assert.equal(
    received.some((e) => e.operation === "run"),
    false,
  );
  assert.equal(f.store.activeRuns(-100, 42)[0]?.requestId, "compact-run");
});

test("stream wake alarm cannot be postponed by a slower status retry", async () => {
  const f = fixture();
  const schedule = (
    f.plane as unknown as { scheduleAlarm: (at: number) => Promise<void> }
  ).scheduleAlarm.bind(f.plane);
  const soon = Date.now() + 1,
    later = Date.now() + 30000;
  await Promise.all([schedule(soon), schedule(later), schedule(later + 15000)]);
  assert.equal(f.getAlarm(), soon);
});

test("accepted streamed run is not resubmitted or status-polled on every token alarm", async (t) => {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveTopicAllocation("fast-stream", -100, 42),
    secret = "s".repeat(64);
  f.store.configureJob(job.jobId, { endpoint: "https://canary.up.railway.app" });
  f.store.ready(
    job.workerId,
    1,
    await encryptCredential(btoa("k".repeat(32)), "node:" + job.workerId + ":1", secret),
  );
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueueVerified(-100, 42, "fast-stream-run", "prompt", 1, 1, "opencode/big-pickle");
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const operations: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("api.telegram.org"))
      return Response.json({ ok: true, result: { message_id: 1 } });
    const e = JSON.parse(String(init?.body));
    operations.push(e.operation);
    const result =
      e.operation === "run"
        ? { accepted: true }
        : e.operation === "callback.status"
          ? { state: "ACCEPTED" }
          : [];
    const signed = await signEnvelope(
      { ...e, nonce: crypto.randomUUID(), timestamp: Date.now(), payload: { ok: true, result } },
      secret,
    );
    return new Response(signed.body, { headers: { "x-node-signature": signed.signature } });
  };
  await f.plane.alarm();
  const count = operations.length;
  await f.plane.alarm();
  await f.plane.alarm();
  assert.equal(operations.length, count);
  assert.equal(operations.filter((o) => o === "run").length, 1);
  assert.equal(f.store.activeRuns(-100, 42)[0]?.requestId, "fast-stream-run");
});

test("General thread 1 credential input uses the same normalized account scope as ingress", async (t) => {
  const f = fixture();
  f.store.setGlobal({}, "initial", 0);
  f.sql.exec(
    "INSERT INTO ui_state VALUES(?,?)",
    "form:7:-100:0",
    JSON.stringify({
      kind: "credential",
      providerId: "integration.github",
      generation: 0,
      expires: Date.now() + 60_000,
    }),
  );
  const protectedUpdate = await protectTelegramCredentialUpdate(
    {
      update_id: 12,
      message: {
        message_id: 12,
        message_thread_id: 1,
        from: { id: 7 },
        chat: { id: -100 },
        text: "fixture-private-token",
      },
    } as never,
    f.sql,
    btoa("k".repeat(32)),
  );
  t.mock.method(globalThis, "fetch", async () => Response.json({ login: "operator" }));
  await (
    f.plane as unknown as {
      saveCredential(
        update: ProtectedTelegramUpdate,
        provider: string,
        generation: number,
      ): Promise<void>;
    }
  ).saveCredential(protectedUpdate, "integration.github", 0);
  assert.equal(
    (f.store.global()?.data.integrations as { github: { accountConnected: boolean } }).github
      .accountConnected,
    true,
  );
  assert.equal(JSON.stringify(f.store.global()).includes("fixture-private-token"), false);
});

test("native Stop without from is ingested and durably fences the exact draft before cancellation", async () => {
  const f = fixture();
  const topic = {
    chatId: 7,
    threadId: 42,
    workerId: "native-worker",
    generation: 1,
    sessionId: "native-session",
    state: "ACTIVE",
  };
  f.sql.exec("INSERT INTO topics VALUES(?,?,?,?)", 7, 42, topic.workerId, JSON.stringify(topic));
  f.store.enqueue(7, 42, "native_run", "prompt");
  f.store.pinRun("native_run", 1, 1, "p/m");
  f.store.startNext(7, 42);
  const binding = {
    ...topic,
    runId: "native_run",
    draftId: 99,
    state: "ACTIVITY",
    summaries: [],
    thinking: [],
    completedThinking: [],
    activities: {},
  };
  f.sql.exec(
    "INSERT INTO telegram_run_presentations VALUES(?,?,?,?,?)",
    "native_run",
    7,
    42,
    99,
    JSON.stringify(binding),
  );
  const stop = {
    update_id: 8801,
    stopped_message_generation: {
      chat: { id: 7, type: "private" },
      message_thread_id: 42,
      draft_id: 99,
    },
  };
  assert.equal((await post(f.plane, "/telegram/webhook", stop)).status, 200);
  assert.equal(
    [...f.sql.exec<{ state: string }>("SELECT state FROM runs WHERE request='native_run'")][0]
      ?.state,
    "CANCELLING",
  );
  assert.equal(
    f.store.recordCallback(7, 42, {
      runId: "native_run",
      streamNonce: "late",
      sequence: 1,
      event: { type: "session.idle" },
    }),
    false,
  );
  assert.equal(f.store.completedResponses().length, 0);
  const firstReceipt = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='native-stop:native_run'"),
  ][0];
  assert.equal(JSON.parse(firstReceipt!.data).updateId, 8801);
  await post(f.plane, "/telegram/webhook", { ...stop, update_id: 8802 });
  assert.equal(
    [
      ...f.sql.exec<{ data: string }>(
        "SELECT data FROM telegram_run_presentations WHERE run='native_run'",
      ),
    ].map((r) => JSON.parse(r.data).state)[0],
    "CANCELLING",
  );
  const duplicateReceipt = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='native-stop:native_run'"),
  ][0];
  assert.equal(JSON.parse(duplicateReceipt!.data).updateId, 8801);
});

async function nativeExecutionFixture() {
  const f = fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveTopicAllocation("native_exec", 7, 42);
  const secret = "n".repeat(64);
  const credential = await encryptCredential(
    btoa("k".repeat(32)),
    "node:" + job.workerId + ":1",
    secret,
  );
  f.store.configureJob(job.jobId, { endpoint: "https://native.up.railway.app" });
  f.store.ready(job.workerId, 1, credential);
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueue(7, 42, "native_exec", "prompt");
  f.store.pinRun("native_exec", 1, f.store.global()?.revision ?? 0, "p/m");
  return { ...f, secret, job };
}
test("native cancellation reaches the signed exact-run Worker stop and joins before queue release", async (t) => {
  const f = await nativeExecutionFixture();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let execution = false;
  const operations: string[] = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).includes("api.telegram.org"))
      return Response.json({
        ok: true,
        result: String(input).endsWith("/getChat")
          ? { id: 7, type: "private" }
          : { message_id: 99 },
      });
    operations.push(body.operation);
    assert.equal(body.sessionId, "session");
    let result: unknown = null;
    if (body.operation === "run") {
      assert.equal(body.payload.runId, "native_exec");
      execution = true;
      result = { accepted: true };
    }
    if (body.operation === "callback.status") result = { state: "ACCEPTED", runId: body.payload.runId };
    if (body.operation === "status") result = execution ? { externalRunId: "native_exec" } : null;
    if (body.operation === "stop") {
      assert.equal(body.payload.runId, "native_exec");
      execution = false;
    }
    if (body.operation.endsWith(".list")) result = [];
    const signed = await signEnvelope(
      { ...body, nonce: crypto.randomUUID(), timestamp: Date.now(), payload: { ok: true, result } },
      f.secret,
    );
    return new Response(signed.body, { headers: { "x-node-signature": signed.signature } });
  };
  await f.plane.alarm();
  const binding = JSON.parse(
    [
      ...f.sql.exec<{ data: string }>(
        "SELECT data FROM telegram_run_presentations WHERE run='native_exec'",
      ),
    ][0]!.data,
  );
  await post(f.plane, "/telegram/webhook", {
    update_id: 9901,
    stopped_message_generation: {
      chat: { id: 7, type: "private" },
      message_thread_id: 42,
      draft_id: binding.draftId,
    },
  });
  await f.plane.alarm();
  assert.equal(execution, false);
  assert.deepEqual(operations.slice(-3), ["status", "stop", "status"]);
  assert.equal(
    [...f.sql.exec<{ state: string }>("SELECT state FROM runs WHERE request='native_exec'")][0]!
      .state,
    "CANCELLED",
  );
});

test("Stop while initial submission is in flight cannot release ownership or start queued execution", async (t) => {
  const f = await nativeExecutionFixture();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let release!: () => void;
  let execution = false;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).includes("api.telegram.org"))
      return Response.json({
        ok: true,
        result: String(input).endsWith("/getChat")
          ? { id: 7, type: "private" }
          : { message_id: 99 },
      });
    let result: unknown = null;
    if (body.operation === "run") {
      await new Promise<void>((r) => {
        release = r;
      });
      execution = true;
      result = { accepted: true };
    }
    if (body.operation === "callback.status") result = { state: "ACCEPTED", runId: body.payload.runId };
    if (body.operation === "status") result = execution ? { externalRunId: "native_exec" } : null;
    if (body.operation === "stop") execution = false;
    if (body.operation.endsWith(".list")) result = [];
    const signed = await signEnvelope(
      { ...body, nonce: crypto.randomUUID(), timestamp: Date.now(), payload: { ok: true, result } },
      f.secret,
    );
    return new Response(signed.body, { headers: { "x-node-signature": signed.signature } });
  };
  const running = f.plane.alarm();
  while (!release) await new Promise((r) => setTimeout(r, 0));
  const binding = JSON.parse(
    [
      ...f.sql.exec<{ data: string }>(
        "SELECT data FROM telegram_run_presentations WHERE run='native_exec'",
      ),
    ][0]!.data,
  );
  await post(f.plane, "/telegram/webhook", {
    update_id: 9902,
    stopped_message_generation: {
      chat: { id: 7, type: "private" },
      message_thread_id: 42,
      draft_id: binding.draftId,
    },
  });
  f.store.enqueue(7, 42, "next_exec", "next");
  await f.plane.alarm();
  assert.equal(f.store.startNext(7, 42), undefined);
  release();
  await running;
  f.sql.exec("UPDATE runs SET state='CANCELLED' WHERE request='next_exec'"); // Keep the test focused on joining the stopped admission.
  await f.plane.alarm();
  assert.equal(execution, false);
  assert.equal(
    [...f.sql.exec<{ state: string }>("SELECT state FROM runs WHERE request='native_exec'")][0]!
      .state,
    "CANCELLED",
  );
});

test("timed-out admission cannot free cancellation ownership while a delayed Worker submission is unknown", async(t)=>{
 const f=await nativeExecutionFixture();const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 let admitted=false,execution=false;
 globalThis.fetch=async(input,init)=>{
  const body=JSON.parse(String(init?.body));
  if(String(input).includes("api.telegram.org"))return Response.json({ok:true,result:String(input).endsWith("/getChat")?{id:7,type:"private"}:{message_id:99}});
  if(body.operation==="run")throw new Error("transport timeout while server keeps processing");
  let result:unknown=null;
  if(body.operation==="callback.status")result={runId:admitted?"native_exec":"previous",state:admitted?"ACCEPTED":"NOT_SUBMITTED"};
  if(body.operation==="status")result=execution?{externalRunId:"native_exec"}:null;
  if(body.operation==="stop")execution=false;
  if(body.operation.endsWith(".list"))result=[];
  const signed=await signEnvelope({...body,nonce:crypto.randomUUID(),timestamp:Date.now(),payload:{ok:true,result}},f.secret);
  return new Response(signed.body,{headers:{"x-node-signature":signed.signature}});
 };
 await f.plane.alarm();
 const binding=JSON.parse([...f.sql.exec<{data:string}>("SELECT data FROM telegram_run_presentations WHERE run='native_exec'")][0]!.data);
 await post(f.plane,"/telegram/webhook",{update_id:9903,stopped_message_generation:{chat:{id:7,type:"private"},message_thread_id:42,draft_id:binding.draftId}});
 f.store.enqueue(7,42,"queued_next","next");await f.plane.alarm();
 assert.equal([...f.sql.exec<{state:string}>("SELECT state FROM runs WHERE request='native_exec'")][0]!.state,"CANCELLING");
 assert.equal(f.store.startNext(7,42),undefined);
 admitted=true;execution=true;f.sql.exec("UPDATE runs SET state='CANCELLED' WHERE request='queued_next'");await f.plane.alarm();
 assert.equal(execution,false);assert.equal([...f.sql.exec<{state:string}>("SELECT state FROM runs WHERE request='native_exec'")][0]!.state,"CANCELLED");
});

test("Stop during identity resolution cancels the unsubmitted run without requiring a Worker admission receipt",async(t)=>{
 const f=await nativeExecutionFixture();const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 let release!:()=>void;
 (f.plane as any).identity=async()=>{await new Promise<void>(r=>{release=r;});throw new Error("identity resolution interrupted");};
 let workerCalls=0;
 globalThis.fetch=async(input)=>{if(!String(input).includes("api.telegram.org")){workerCalls++;throw new Error("must not submit");}return Response.json({ok:true,result:String(input).endsWith("/getChat")?{id:7,type:"private"}:{message_id:99}});};
 const running=f.plane.alarm();while(!release)await new Promise(r=>setTimeout(r,0));
 const binding=JSON.parse([...f.sql.exec<{data:string}>("SELECT data FROM telegram_run_presentations WHERE run='native_exec'")][0]!.data);
 await post(f.plane,"/telegram/webhook",{update_id:9904,stopped_message_generation:{chat:{id:7,type:"private"},message_thread_id:42,draft_id:binding.draftId}});
 assert.equal(Boolean(f.store.runPin("native_exec")?.dispatched),false);
 release();await running;await f.plane.alarm();
 assert.equal(workerCalls,0);assert.equal([...f.sql.exec<{state:string}>("SELECT state FROM runs WHERE request='native_exec'")][0]!.state,"CANCELLED");
});

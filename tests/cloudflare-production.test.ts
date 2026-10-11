import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { encryptCredential } from "../src/cloudflare/credentials.js";
import { signEnvelope } from "../src/cloudflare/protocol.js";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { ControlPlane } from "../src/cloudflare/control-object.js";
import { CloudCapabilityBroker } from "../src/cloudflare/capability-broker.js";
import { createIntegrationRegistry } from "../src/cloudflare/integration-registry.js";
import {
  protectTelegramCredentialUpdate,
  type ProtectedTelegramUpdate,
} from "../src/cloudflare/credential-vault.js";
import { CloudCredentialVault } from "../src/cloudflare/credential-vault.js";
import { RailwayCredentialStore } from "../src/cloudflare/railway-credential-store.js";
async function fixture() {
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
    CORE_AUTO_UPDATE: "false",
    TELEGRAM_BOT_TOKEN: "synthetic-telegram",
    MAX_WORKERS: "10",
    WORKERS_PER_PROJECT: "5",
    MAX_RAILWAY_PROJECTS: "2",
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
  const store = new ControlStore(sql, tx);
  await new RailwayCredentialStore(sql, env.CREDENTIAL_MASTER_KEY).save({
    accountId: "account-1",
    accountName: "Primary Railway",
    token: "synthetic-provisioning-secret",
  });
  return { plane, sql, queued, getAlarm: () => alarmAt, store };
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
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveAllocation("bootstrap-unbound", -100);
  f.store.configureJob(job.jobId, {
    serviceId: "service",
    projectId: "project",
    environmentId: "env",
  });
  const token = "bootstrap-token";
  f.store.issueBootstrap(job.jobId, await tokenHash(token), Date.now() + 60_000);
  const response = await post(f.plane, "/nodes/bootstrap", {
    bootstrapToken: token,
    serviceId: "service",
    projectId: "project",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    identity: { nodeId: string; generation: number; chatId: number; threadId: number };
  };
  assert.deepEqual(body.identity, {
    nodeId: job.workerId,
    generation: 1,
    chatId: 0,
    threadId: 0,
  });
});

test("global account selection and removal publish only the selected credential grant", async (t) => {
  const f = await fixture();
  f.store.setGlobal({}, "initial", 0);
  t.mock.method(globalThis, "fetch", async () => Response.json({ login: "operator" }));
  const { CloudIntegrationConnections } =
    await import("../src/cloudflare/integration-connections.js");
  const connections = new CloudIntegrationConnections(f.sql, btoa("k".repeat(32)));
  const first = await connections.connect("github", "first-secret");
  const second = await connections.prepare("github", "second-secret");
  connections.activate(second, "add");
  const manage = (
    f.plane as unknown as {
      manageIntegration(id: string, action: string, credentialId: string): Promise<void>;
    }
  ).manageIntegration.bind(f.plane);
  await manage("github", "select", first.credentialId);
  assert.equal(
    (f.store.global()?.data.credentialReferences as { credentialId: string }[])[0].credentialId,
    first.credentialId,
  );
  await manage("github", "remove", first.credentialId);
  assert.equal(
    (f.store.global()?.data.credentialReferences as { credentialId: string }[])[0].credentialId,
    second.credentialId,
  );
  await manage("github", "remove", second.credentialId);
  assert.deepEqual(f.store.global()?.data.credentialReferences, []);
  await assert.rejects(
    manage("github", "select", first.credentialId),
    /integration_account_unavailable/,
  );
  assert.equal(JSON.stringify(f.store.global()).includes("secret"), false);
});
test("legacy provider credentials migrate to the generic broker without changing proxy references", async () => {
  const f = await fixture();
  const metadata = await new CloudCredentialVault(f.sql, btoa("k".repeat(32))).saveProvider(
    "sample",
    "provider-private-secret",
  );
  const apiKey = "bot-credential-proxy:" + metadata.capability + ":" + metadata.credentialId;
  f.store.setGlobal(
    {
      configuration: { runtime: { provider: { sample: { options: { apiKey } } } } },
      credentialReferences: [metadata],
    },
    "initial",
    0,
  );
  await (
    f.plane as unknown as { migrateLegacyCredentials(): Promise<void> }
  ).migrateLegacyCredentials();
  const data = f.store.global()!.data;
  const references = data.credentialReferences as {
    integrationId: string;
    credentialId: string;
    capabilities: string[];
  }[];
  assert.equal(references[0].integrationId, "provider:sample");
  assert.equal(references[0].credentialId, metadata.credentialId);
  assert.deepEqual(references[0].capabilities, ["provider.request"]);
  assert.equal((data.configuration as any).runtime.provider.sample.options.apiKey, apiKey);
  const registry = createIntegrationRegistry(["sample"]);
  const broker = new CloudCapabilityBroker(f.sql, btoa("k".repeat(32)), registry, () => undefined);
  assert.equal(
    await broker.readAccount("provider:sample", metadata.credentialId),
    "provider-private-secret",
  );
  assert.equal(
    JSON.stringify([...f.sql.exec("SELECT data FROM ui_state")]).includes(
      "provider-private-secret",
    ),
    false,
  );
});

test("legacy maximum-length provider names retain generic credential compatibility", async () => {
  const f = await fixture();
  const id = "p".repeat(128);
  const metadata = await new CloudCredentialVault(f.sql, btoa("k".repeat(32))).saveProvider(
    id,
    "private-provider-value",
  );
  f.store.setGlobal(
    {
      configuration: {
        runtime: {
          provider: {
            [id]: {
              options: {
                apiKey: "bot-credential-proxy:" + metadata.capability + ":" + metadata.credentialId,
              },
            },
          },
        },
      },
      credentialReferences: [metadata],
    },
    "initial",
    0,
  );
  await (
    f.plane as unknown as { migrateLegacyCredentials(): Promise<void> }
  ).migrateLegacyCredentials();
  assert.equal(
    (f.store.global()!.data.credentialReferences as { integrationId: string }[])[0].integrationId,
    "provider:" + id,
  );
});

test("provider credential rotation uses the generic store and revokes the displaced reference atomically", async () => {
  const f = await fixture();
  f.store.setGlobal(
    { configuration: { runtime: { provider: { sample: { options: {} } } } } },
    "initial",
    0,
  );
  const save = (
    f.plane as unknown as {
      saveCredential(
        update: ProtectedTelegramUpdate,
        provider: string,
        generation: number,
      ): Promise<void>;
    }
  ).saveCredential.bind(f.plane);
  const submit = async (value: string, updateId: number) => {
    f.sql.exec(
      "INSERT INTO ui_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      "form:7:-100:0",
      JSON.stringify({
        kind: "credential",
        providerId: "sample",
        generation: 0,
        expires: Date.now() + 60000,
      }),
    );
    const update = await protectTelegramCredentialUpdate(
      {
        update_id: updateId,
        message: { message_id: updateId, from: { id: 7 }, chat: { id: -100 }, text: value },
      } as never,
      f.sql,
      btoa("k".repeat(32)),
    );
    await save(update, "sample", 0);
    return (
      f.store.global()!.data.credentialReferences as {
        integrationId: string;
        credentialId: string;
      }[]
    )[0];
  };
  const first = await submit("first-provider-private", 40);
  assert.equal(first.integrationId, "provider:sample");
  const second = await submit("second-provider-private", 41);
  const broker = new CloudCapabilityBroker(
    f.sql,
    btoa("k".repeat(32)),
    createIntegrationRegistry(["sample"]),
    () => undefined,
  );
  assert.equal(
    await broker.readAccount("provider:sample", second.credentialId),
    "second-provider-private",
  );
  await assert.rejects(
    broker.readAccount("provider:sample", first.credentialId),
    /invalid_credential/,
  );
  assert.equal([...f.sql.exec("SELECT key FROM ui_state WHERE key='credential:sample'")].length, 0);
  assert.equal(JSON.stringify(f.store.global()).includes("provider-private"), false);
});

test("production signed transport leases only a current Topic capability reference", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).startsWith("https://api.github.com/")
      ? Response.json({ private: true })
      : new Response("refs", {
          headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
        });
  t.after(() => {
    globalThis.fetch = original;
  });
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.reserveTopicAllocation("broker", -100, 42);
  const secret = "n".repeat(64);
  const master = btoa("k".repeat(32));
  f.store.ready(
    job.workerId,
    1,
    await encryptCredential(master, "node:" + job.workerId + ":1", secret),
  );
  f.store.bindTopic(job.jobId, 42, "session");
  f.store.enqueue(-100, 42, "broker-run", "fixture prompt");
  f.store.startNext(-100, 42);
  const broker = new CloudCapabilityBroker(
    f.sql,
    master,
    createIntegrationRegistry(),
    () => undefined,
  );
  const reference = await broker.save("github", "fixture-github-secret", ["repo.read"]);
  await post(f.plane, "/admin/global", {
    configuration: { runtime: {} },
    skills: [],
    actions: [],
    catalog: {},
    defaults: {},
    credentialReferences: [{ ...reference, capabilities: ["repo.read"] }],
  });
  async function call(operation: string, payload: unknown, change = {}) {
    const signed = await signEnvelope(
      {
        version: 1,
        nodeId: job.workerId,
        generation: 1,
        chatId: -100,
        threadId: 42,
        sessionId: "session",
        timestamp: Date.now(),
        nonce: crypto.randomUUID().replaceAll("-", ""),
        operation,
        payload,
        ...change,
      },
      secret,
    );
    return f.plane.fetch(
      new Request("https://internal/node-control", {
        method: "POST",
        body: signed.body,
        headers: { "x-node-signature": signed.signature },
      }),
    );
  }
  const payload = {
    integrationId: reference.integrationId,
    credentialId: reference.credentialId,
    capability: "repo.read",
    scopes: ["repo.read"],
    workerId: job.workerId,
    topicId: "-100:42",
    generation: 1,
    sessionId: "session",
    resource: "owner/repository",
  };
  const authorized = await call("capability.authorize", payload);
  assert.equal(authorized.status, 200);
  const authorization = (await authorized.json()).payload;
  assert.equal(authorization.authorized, true);
  assert.equal(Object.hasOwn(authorization, "value"), false);
  assert.equal((await call("capability.authorize", { ...payload, scopes: [] })).status, 409);
  const acquired = await call("credential.acquire", payload);
  assert.equal(acquired.status, 200);
  const lease = (await acquired.json()).payload;
  assert.equal(lease.value, "fixture-github-secret");
  assert.equal((await call("credential.validate", { leaseId: lease.leaseId })).status, 200);
  assert.equal((await call("credential.acquire", { ...payload, topicId: "-100:43" })).status, 409);
  assert.equal((await call("credential.acquire", payload, { generation: 2 })).status, 409);
  assert.equal(
    (await call("credential.acquire", { ...payload, capability: "repo.write" })).status,
    409,
  );
  broker.remove(reference.credentialId);
  assert.equal((await call("capability.authorize", payload)).status, 409);
  assert.equal((await call("credential.validate", { leaseId: lease.leaseId })).status, 409);
  assert.equal((await call("credential.release", { leaseId: lease.leaseId })).status, 200);
  assert.equal(
    JSON.stringify([...f.sql.exec("SELECT data FROM ui_state")]).includes("fixture-github-secret"),
    false,
  );
});
test("production setup stores only Railway account metadata while the token stays encrypted separately", async () => {
  const f = await fixture();
  const response = await post(f.plane, "/admin/setup");
  assert.equal(response.status, 200);
  const rows = [...f.sql.exec("SELECT data FROM backends")] as Array<{ data: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.data.includes("synthetic-provisioning-secret"), false);
  const backend = JSON.parse(rows[0]!.data);
  assert.equal(backend.accountId, "account-1");
  assert.equal("credential" in backend, false);
  const credentialRow = [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='infrastructure:railway:credential'")][0]!;
  assert.equal(credentialRow.data.includes("synthetic-provisioning-secret"), false);
  assert.equal(([...f.sql.exec("SELECT id FROM projects")] as unknown[]).length, 0);
});
test("equivalent Topic create request allocates once and never activates an unready Worker", async () => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const body = { requestId: "canary", chatId: -100, threadId: 42 };
  const a = await (await post(f.plane, "/admin/topics", body)).json();
  const b = await (await post(f.plane, "/admin/topics", body)).json();
  assert.equal(a.workerId, b.workerId);
  assert.equal(a.jobId, b.jobId);
  assert.equal(([...f.sql.exec("SELECT worker FROM topics")] as unknown[]).length, 0);
});
test("General Topic admission rejects before reserving infrastructure", async () => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  assert.equal(
    (await post(f.plane, "/admin/topics", { requestId: "general", chatId: -100, threadId: 1 }))
      .status,
    409,
  );
  assert.equal(([...f.sql.exec("SELECT id FROM workers")] as unknown[]).length, 0);
});

test("Telegram chunk retry preserves already delivered chunks", async (t) => {
  const f = await fixture();
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
  const f = await fixture();
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

test("admin canary and webhook share idempotent Topic creation from the fixed ready fleet", async (t) => {
  const f = await fixture(),
    original = globalThis.fetch;
  await post(f.plane, "/admin/setup");
  const fixed = f.store.ensureFixedFleet("railway", 10, 5)[0]!;
  f.store.saveProject({
    ...f.store.projects().find((project) => project.projectKey === fixed.projectKey)!,
    projectId: "project-1",
    environmentId: "environment-1",
    phase: "READY",
  });
  f.store.configureJob(fixed.jobId, {
    projectId: "project-1",
    environmentId: "environment-1",
    serviceId: "service-1",
    volumeId: "volume-1",
    endpoint: "https://worker-01.up.railway.app",
    phase: "READY_UNBOUND",
  });
  f.store.ready("worker-01", 1, "prepared-credential");
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
  assert.equal(f.store.workers().length, 10);
  assert.equal(f.store.worker("worker-01")?.state, "BINDING");
  assert.equal(f.store.topics().length, 0);
});

test("text deltas append exactly once and retain assistant ownership", async () => {
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
    const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
  const schedule = (
    f.plane as unknown as { scheduleAlarm: (at: number) => Promise<void> }
  ).scheduleAlarm.bind(f.plane);
  const soon = Date.now() + 1,
    later = Date.now() + 30000;
  await Promise.all([schedule(soon), schedule(later), schedule(later + 15000)]);
  assert.equal(f.getAlarm(), soon);
});

test("accepted streamed run is not resubmitted or status-polled on every token alarm", async (t) => {
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
    if (body.operation === "callback.status")
      result = { state: "ACCEPTED", runId: body.payload.runId };
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
    if (body.operation === "callback.status")
      result = { state: "ACCEPTED", runId: body.payload.runId };
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

test("timed-out admission cannot free cancellation ownership while a delayed Worker submission is unknown", async (t) => {
  const f = await nativeExecutionFixture();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let admitted = false,
    execution = false;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).includes("api.telegram.org"))
      return Response.json({
        ok: true,
        result: String(input).endsWith("/getChat")
          ? { id: 7, type: "private" }
          : { message_id: 99 },
      });
    if (body.operation === "run")
      throw new Error("transport timeout while server keeps processing");
    let result: unknown = null;
    if (body.operation === "callback.status")
      result = {
        runId: admitted ? "native_exec" : "previous",
        state: admitted ? "ACCEPTED" : "NOT_SUBMITTED",
      };
    if (body.operation === "status") result = execution ? { externalRunId: "native_exec" } : null;
    if (body.operation === "stop") execution = false;
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
    update_id: 9903,
    stopped_message_generation: {
      chat: { id: 7, type: "private" },
      message_thread_id: 42,
      draft_id: binding.draftId,
    },
  });
  f.store.enqueue(7, 42, "queued_next", "next");
  await f.plane.alarm();
  assert.equal(
    [...f.sql.exec<{ state: string }>("SELECT state FROM runs WHERE request='native_exec'")][0]!
      .state,
    "CANCELLING",
  );
  assert.equal(f.store.startNext(7, 42), undefined);
  admitted = true;
  execution = true;
  f.sql.exec("UPDATE runs SET state='CANCELLED' WHERE request='queued_next'");
  await f.plane.alarm();
  assert.equal(execution, false);
  assert.equal(
    [...f.sql.exec<{ state: string }>("SELECT state FROM runs WHERE request='native_exec'")][0]!
      .state,
    "CANCELLED",
  );
});

test("Stop during identity resolution cancels the unsubmitted run without requiring a Worker admission receipt", async (t) => {
  const f = await nativeExecutionFixture();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let release!: () => void;
  (f.plane as any).identity = async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    throw new Error("identity resolution interrupted");
  };
  let workerCalls = 0;
  globalThis.fetch = async (input) => {
    if (!String(input).includes("api.telegram.org")) {
      workerCalls++;
      throw new Error("must not submit");
    }
    return Response.json({
      ok: true,
      result: String(input).endsWith("/getChat") ? { id: 7, type: "private" } : { message_id: 99 },
    });
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
    update_id: 9904,
    stopped_message_generation: {
      chat: { id: 7, type: "private" },
      message_thread_id: 42,
      draft_id: binding.draftId,
    },
  });
  assert.equal(Boolean(f.store.runPin("native_exec")?.dispatched), false);
  release();
  await running;
  await f.plane.alarm();
  assert.equal(workerCalls, 0);
  assert.equal(
    [...f.sql.exec<{ state: string }>("SELECT state FROM runs WHERE request='native_exec'")][0]!
      .state,
    "CANCELLED",
  );
});

test("Delete Chat fences output, sanitizes runtime, preserves Railway Service/Volume, and queues fixed Worker recycle", async (t) => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  await post(f.plane, "/admin/global", {
    configuration: { runtime: { model: "opencode/big-pickle" } },
    skills: [], actions: [], catalog: {}, defaults: {}, credentialReferences: [],
  });
  const bootstrap = f.store.ensureFixedFleet("railway", 10, 5)[0]!;
  f.store.saveProject({
    ...f.store.projects().find((project) => project.projectKey === bootstrap.projectKey)!,
    projectId: "project-1", environmentId: "environment-1", phase: "READY",
  });
  f.store.configureJob(bootstrap.jobId, {
    projectId: "project-1", environmentId: "environment-1", serviceId: "service-1",
    volumeId: "volume-1", endpoint: "https://worker-01.up.railway.app", phase: "READY_UNBOUND",
  });
  const secret1 = "m".repeat(64);
  const credential1 = await encryptCredential(btoa("k".repeat(32)), "node:worker-01:1", secret1);
  f.store.ready("worker-01", 1, credential1);
  const job = f.store.reservePreparedAllocation("delete-order", -100);
  f.store.markSessionProbed(job.jobId);
  const rotated = f.store.rotateAllocationToTopic(job.jobId, 42);
  const secret = "n".repeat(64);
  const credential = await encryptCredential(btoa("k".repeat(32)), "node:worker-01:2", secret);
  f.store.ready("worker-01", rotated.generation, credential);
  const topic = f.store.bindTopic(job.jobId, 42, "session");
  const revision = f.store.global()!.revision;
  f.store.enqueueVerified(-100, 42, "delete-run", "prompt", topic.generation, revision, "opencode/big-pickle");
  f.store.startNext(-100, 42);
  f.sql.exec(
    "INSERT INTO telegram_run_presentations VALUES(?,?,?,?,?)",
    "delete-run", -100, 42, 77,
    JSON.stringify({
      chatId: -100, threadId: 42, sessionId: "session", generation: topic.generation,
      workerId: topic.workerId, runId: "delete-run", draftId: 77, state: "STREAMING",
      summaries: [], thinking: [], completedThinking: [], activities: {},
    }),
  );
  const order: string[] = [];
  const retirePayloads: unknown[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const payload = JSON.parse(String(init?.body));
    if (url.includes("api.telegram.org")) {
      if (url.endsWith("/deleteForumTopic")) order.push("deleteForumTopic");
      return Response.json({ ok: true, result: true });
    }
    order.push(payload.operation);
    if (payload.operation === "retire") retirePayloads.push(payload.payload);
    const result =
      payload.operation === "status" ? null :
      payload.operation === "retire" ? { retired: true, sanitized: true } : true;
    const signed = await signEnvelope(
      { ...payload, nonce: crypto.randomUUID(), timestamp: Date.now(), payload: { ok: true, result } },
      secret,
    );
    return new Response(signed.body, { headers: { "x-node-signature": signed.signature } });
  };
  const response = await post(f.plane, "/admin/delete-topic", { chatId: -100, threadId: 42 });
  assert.equal(response.status, 200);
  assert.deepEqual(order, ["stop", "retire", "deleteForumTopic"]);
  assert.deepEqual(retirePayloads, [{ sanitize: true }]);
  const worker = f.store.worker("worker-01")!;
  assert.equal(worker.state, "RECOVERING");
  assert.equal(worker.generation, 3);
  assert.equal(worker.serviceId, "service-1");
  assert.equal(worker.volumeId, "volume-1");
  assert.equal(f.store.topics().length, 0);
  assert.ok(f.store.jobs().some((candidate) => candidate.requestId === "fleet-recycle:worker-01:3"));
  assert.ok(f.queued.some((item: any) => f.store.job(item.jobId)?.requestId === "fleet-recycle:worker-01:3"));
  const presentation = [...f.sql.exec<{ data: string }>(
    "SELECT data FROM telegram_run_presentations WHERE run=?", "delete-run",
  )][0];
  assert.equal(JSON.parse(presentation!.data).state, "CANCELLED");
});

test("Railway rate limit creates a shared Retry-After backoff across fixed fleet jobs", async (t) => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const jobs = f.store.ensureFixedFleet("railway", 10, 5);
  const first = jobs.find((job) => job.workerId === "worker-01")!;
  const second = jobs.find((job) => job.workerId === "worker-02")!;
  const { RailwayApiError } = await import("../src/cloudflare/railway-fleet-driver.js");
  let calls = 0;
  t.mock.method(f.plane as any, "advance", async () => {
    calls++;
    throw new RailwayApiError("railway_rate_limited", 7_000);
  });
  const before = Date.now();
  await (f.plane as any).advanceSafely(first.jobId);
  assert.equal(calls, 1);
  assert.ok((f.getAlarm() ?? 0) >= before + 6_900);

  await (f.plane as any).advanceSafely(second.jobId);
  assert.equal(calls, 1);
});


test("Railway transport timeout creates a shared backoff across fixed fleet jobs", async (t) => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const jobs = f.store.ensureFixedFleet("railway", 10, 5);
  const first = jobs.find((job) => job.workerId === "worker-01")!;
  const second = jobs.find((job) => job.workerId === "worker-02")!;
  const { RailwayApiError } = await import("../src/cloudflare/railway-fleet-driver.js");
  let calls = 0;
  t.mock.method(f.plane as any, "advance", async () => {
    calls++;
    throw new RailwayApiError("railway_transport_timeout");
  });
  const before = Date.now();
  await (f.plane as any).advanceSafely(first.jobId);
  assert.equal(calls, 1);
  assert.ok((f.getAlarm() ?? 0) >= before + 29_000);

  await (f.plane as any).advanceSafely(second.jobId);
  assert.equal(calls, 1);
});

test("fixed bootstrap queue retains provider failure until explicit resume without changing 2x5 topology", async (t) => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const jobs = f.store.ensureFixedFleet("railway", 10, 5);
  const firstProject = f.store.projects().find((project) => project.projectKey === "opencode-telegram-01")!;
  f.store.saveProject({ ...firstProject, phase: "CREATING" });
  for (const job of jobs.filter((candidate) => candidate.projectKey === firstProject.projectKey)) {
    f.store.configureJob(job.jobId, { phase: "FAILED", error: "railway_api_failure" });
    f.store.transition(job.workerId, job.generation, "UNHEALTHY");
  }
  const first = jobs.find((job) => job.workerId === "worker-01")!;
  assert.equal(f.store.job(first.jobId)?.phase, "FAILED");
  assert.equal(
    f.store.projects().find((project) => project.projectKey === firstProject.projectKey)?.phase,
    "CREATING",
  );
  let observedJobId: string | undefined;
  let observedJobPhase: string | undefined;
  let observedProjectPhase: string | undefined;
  t.mock.method(f.plane as any, "advance", async (jobId: string) => {
    observedJobId = jobId;
    observedJobPhase = f.store.job(jobId)?.phase;
    observedProjectPhase = f.store.projects().find(
      (project) => project.projectKey === firstProject.projectKey,
    )?.phase;
  });

  await (f.plane as any).advanceSafely(first.jobId);

  assert.equal(observedJobId, undefined);
  assert.equal(f.store.job(first.jobId)?.phase, "FAILED");
  f.store.ensureFixedFleet("railway", 10, 5, true);
  await (f.plane as any).advanceSafely(first.jobId);
  assert.equal(observedJobId, first.jobId);
  assert.equal(observedJobPhase, "RESERVED");
  assert.equal(observedProjectPhase, "RESERVED");
  const backend = f.store.backends().find((candidate) => candidate.backendId === "railway")!;
  assert.equal(backend.maxWorkersPerProject, 5);
  assert.equal(backend.maxProjects, 2);
  assert.deepEqual(
    f.store
      .projects()
      .filter((project) => /^opencode-telegram-\d{2}$/u.test(project.projectKey))
      .map((project) => project.projectKey),
    ["opencode-telegram-01", "opencode-telegram-02"],
  );
});

test("alarm self-reschedules are clamped so a logic loop cannot burn the daily Durable Objects row-read quota", async () => {
  const f = await fixture();
  const started = Date.now();
  (f.plane as any).alarmRunning = true;
  await (f.plane as any).scheduleAlarm(started + 1);
  assert.ok((f.getAlarm() ?? 0) >= started + 4_900);
});

test("idle alarm does not scan retained allocation-job history", async () => {
  const f = await fixture();
  for (let i = 0; i < 500; i++) {
    const job = {
      jobId: `history-${i}`,
      requestId: `history-${i}`,
      chatId: -100,
      workerId: `retired-${i}`,
      backendId: "railway",
      generation: 1,
      phase: "BOUND",
    };
    f.sql.exec(
      "INSERT INTO jobs(id,request,chat,data) VALUES(?,?,?,?)",
      job.jobId,
      job.requestId,
      job.chatId,
      JSON.stringify(job),
    );
  }
  const original = f.sql.exec.bind(f.sql);
  let jobRowsReadByAlarm = 0;
  f.sql.exec = ((query: string, ...args: unknown[]) => {
    const rows = original(query, ...args) as unknown[];
    if (/SELECT\s+data\s+FROM\s+jobs/iu.test(query)) jobRowsReadByAlarm += rows.length;
    return rows as never;
  }) as typeof f.sql.exec;

  await f.plane.alarm();
  assert.ok(jobRowsReadByAlarm <= 20, `alarm read ${jobRowsReadByAlarm} retained jobs`);
});


test("paused infrastructure does not restart provisioning or schedule a retry on an unrelated alarm", async (t) => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.ensureFixedFleet("railway", 10, 5)[0]!;
  f.sql.exec("INSERT INTO ui_state VALUES('railway:onboarding:paused','{}')");
  let advanced = 0;
  t.mock.method(f.plane as any, "advance", async () => { advanced++; });
  await (f.plane as any).advanceSafely(job.jobId);
  assert.equal(advanced, 0);
  assert.equal(f.getAlarm(), null);
});

test("Telegram control updates are processed before infrastructure I/O", async (t) => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  f.store.ensureFixedFleet("railway", 10, 5);
  f.store.recordTelegramUpdate(991, JSON.stringify({ update_id: 991, message: { from: { id: 7 }, chat: { id: 7 }, text: "/start" } }));
  let handled = false;
  t.mock.method(f.plane as any, "ui", () => ({ handle: async () => { handled = true; return true; } }));
  const observed: boolean[] = [];
  t.mock.method(f.plane as any, "advanceSafely", async () => { observed.push(handled); });
  await f.plane.alarm();
  assert.equal(observed.length, 0, "control traffic must have its own alarm turn");
  await f.plane.alarm();
  assert.ok(observed.length > 0);
  assert.ok(observed.every(Boolean), "provisioning must not block /start");
  assert.equal(handled, true);
  assert.equal(f.store.hasPendingTelegramUpdates(), false);
});

test("new ingress replaces an overdue alarm left behind by exhausted platform retries", async () => {
  const f = await fixture();
  let armed: number | undefined;
  const plane = new ControlPlane({ storage: { sql: f.sql,
    transactionSync: <T>(action: () => T) => action(),
    getAlarm: async () => Date.now() - 60_000,
    setAlarm: async (value: number) => { armed = value; },
  } } as never, { TELEGRAM_ALLOWED_USER_ID: "7" } as never);
  const next = Date.now() + 1_000;
  await (plane as any).scheduleAlarm(next);
  assert.equal(armed, next, "a stale alarm must not strand durable /start updates");
});

test("cold construction rearms a persisted Telegram backlog without an additional user message", async () => {
  const f = await fixture();
  f.store.recordTelegramUpdate(993, JSON.stringify({ update_id: 993, message: { from: { id: 7 }, chat: { id: 7 }, text: "/start" } }));
  const pending: Promise<unknown>[] = [];
  let armed = false;
  new ControlPlane({ waitUntil: (work: Promise<unknown>) => pending.push(work), storage: { sql: f.sql,
    transactionSync: <T>(action: () => T) => action(), getAlarm: async () => Date.now() - 60_000,
    setAlarm: async () => { armed = true; },
  } } as never, { TELEGRAM_ALLOWED_USER_ID: "7" } as never);
  await Promise.all(pending);
  assert.equal(armed, true);
});

test("explicit Railway resume renews paused bootstrap deadlines and rechecks cached projects", async () => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.ensureFixedFleet("railway", 10, 5)[0]!;
  const old = Date.now() - 24 * 60 * 60_000;
  f.store.configureJob(job.jobId, { createdAt: old });
  const project = f.store.projects().find(p => p.projectKey === job.projectKey)!;
  f.store.saveProject({ ...project, phase: "READY", projectId: "cached-project", environmentId: "cached-environment" });
  await (f.plane as any).resumeRailwaySetup();
  assert.ok(f.store.job(job.jobId)!.createdAt! > old);
  assert.equal((f.plane as any).railwaySetupStatus().projectsCreated, 0);
  assert.equal(f.store.projects().find(p => p.projectKey === job.projectKey)!.projectId, "cached-project");
});

test("resource creation pause permits finishing an already owned service and volume", async (t) => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.ensureFixedFleet("railway", 10, 5)[0]!;
  f.store.configureJob(job.jobId, { serviceId: "owned-service", volumeId: "owned-volume", phase: "VOLUME_ATTACHING" });
  f.sql.exec("INSERT INTO ui_state VALUES('railway:onboarding:paused','{}')");
  let advanced = 0;
  t.mock.method(f.plane as any, "advance", async () => { advanced++; });
  await (f.plane as any).advanceSafely(job.jobId);
  assert.equal(advanced, 1);
});

test("daily service creation pause permits adding a volume to an owned service", async (t) => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const job = f.store.ensureFixedFleet("railway", 10, 5)[0]!;
  f.store.configureJob(job.jobId, { serviceId: "owned-service", phase: "RESERVED" });
  f.sql.exec("INSERT INTO ui_state VALUES(?,?)", "railway:onboarding:paused", JSON.stringify({ reason: "railway_creation_limited" }));
  let advanced = 0;
  t.mock.method(f.plane as any, "advance", async () => { advanced++; });
  await (f.plane as any).advanceSafely(job.jobId);
  assert.equal(advanced, 1);
});

test("capacity changes persist a non-multiple-of-five target", async () => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  f.store.ensureFixedFleet("railway", 10, 5);
  await (f.plane as any).setRailwayCapacity(7);
  assert.equal((f.plane as any).railwaySetupStatus().totalWorkers, 7);
  assert.equal(f.store.backends()[0]!.desiredMaximumWorkers, 7);
  await (f.plane as any).setup();
  assert.equal(f.store.backends()[0]!.desiredMaximumWorkers, 7);
  await assert.rejects(() => (f.plane as any).setRailwayCapacity(0), /invalid_capacity_policy/);
});

for (const loseReply of [false, true]) test(`prepared New Chat rotates in place without deployment${loseReply ? " and recovers a lost rotation reply" : ""}`, async (t) => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const bootstrap = f.store.ensureFixedFleet("railway", 10, 5)[0]!;
  f.store.configureJob(bootstrap.jobId, {
    projectId: "project", environmentId: "environment", serviceId: "service",
    volumeId: "volume", endpoint: "https://worker-01.up.railway.app", phase: "READY_UNBOUND",
  });
  let secret = "s".repeat(64);
  f.store.ready(bootstrap.workerId, 1, await encryptCredential(btoa("k".repeat(32)), "node:worker-01:1", secret));
  const job = f.store.reservePreparedAllocation("prepared-chat", -100);
  t.mock.method(f.plane as any, "topicUi", () => ({ ready: async () => {} }));
  t.mock.method(f.plane as any, "allocationProgress", async () => {});
  const operations: string[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(!url.includes("backboard.railway"), "New Chat must not contact Railway");
    const body = JSON.parse(String(init?.body));
    if (url.includes("api.telegram.org")) {
      return Response.json({ ok: true, result: url.endsWith("createForumTopic") ? { message_thread_id: 42 } : true });
    }
    operations.push(body.operation);
    const signingSecret = secret;
    let result: unknown;
    switch (body.operation) {
      case "health": result = { ready: true, bindingRotation: true }; break;
      case "session.probe": result = { created: true, deleted: true }; break;
      case "retire": result = { retired: true, sanitized: true }; break;
      case "binding.rotate": {
        const response = await post(f.plane, "/nodes/bootstrap", { bootstrapToken: body.payload.bootstrapToken, serviceId: "service", projectId: "project" });
        assert.equal(response.status, 200);
        const credentials = await response.json() as { secret: string; identity: { generation: number } };
        secret = credentials.secret;
        assert.equal(credentials.identity.generation, 2);
        result = { rotated: true };
        if (loseReply) throw new Error("connection lost after bootstrap");
        break;
      }
      case "sync-global": result = { revision: f.store.global()!.revision, hash: f.store.global()!.hash }; break;
      case "session.create": result = { sessionId: "session" }; break;
      default: throw new Error("Unexpected operation: " + body.operation);
    }
    const signed = await signEnvelope({ ...body, nonce: crypto.randomUUID(), timestamp: Date.now(), payload: { ok: true, result } }, signingSecret);
    return new Response(signed.body, { headers: { "x-node-signature": signed.signature } });
  };
  await (f.plane as any).advance(job.jobId);
  if (loseReply) await assert.rejects((f.plane as any).advance(job.jobId), /worker_unavailable/u);
  await (f.plane as any).advance(job.jobId);
  assert.equal(f.store.job(job.jobId)!.phase, "BOUND");
  assert.equal(f.store.worker("worker-01")!.serviceId, "service");
  assert.equal(f.store.worker("worker-01")!.volumeId, "volume");
  assert.deepEqual(operations, ["health", "session.probe", "retire", "binding.rotate", "health", "sync-global", "session.create"]);
  assert.equal(f.store.topics().length, 1);
});

test("automatic Core rollout advances one prepared worker per maintenance pass", async t => {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const { WorkerImageUpgrade } = await import("../src/cloudflare/worker-image-upgrade.js");
  for (const job of f.store.ensureFixedFleet("railway", 10, 5).slice(0, 2)) {
    f.store.configureJob(job.jobId, { projectId: "project", environmentId: "environment", serviceId: job.workerId, volumeId: "volume-" + job.workerId, endpoint: "https://" + job.workerId + ".up.railway.app", phase: "READY_UNBOUND" });
    f.store.ready(job.workerId, 1, "synthetic-encrypted-credential");
  }
  (f.plane as any).env.CORE_AUTO_UPDATE = "true";
  f.sql.exec("INSERT INTO ui_state(key,data) VALUES('core-update:poll',?)", JSON.stringify(Date.now() + 900_000));
  const calls: string[] = [];
  t.mock.method(WorkerImageUpgrade.prototype, "advance", async (workerId: string, generation: number, target: unknown) => {
    calls.push(workerId);
    return { workerId, generation, target, phase: "COMPLETE" };
  });
  await (f.plane as any).updateCoreFleet();
  assert.deepEqual(calls, ["worker-01"]);
  assert.ok(f.getAlarm());
});

async function preparedPausedFixture() {
  const f = await fixture();
  await post(f.plane, "/admin/setup");
  const bootstrap = f.store.ensureFixedFleet("railway", 10, 5)[0]!;
  f.store.configureJob(bootstrap.jobId, { projectId: "project", environmentId: "env", serviceId: "owned-service", volumeId: "owned-volume", endpoint: "https://worker-01.up.railway.app", phase: "READY_UNBOUND" });
  f.store.ready(bootstrap.workerId, 1, "synthetic");
  const job = f.store.reservePreparedAllocation("paused-chat", -100);
  f.store.configureJob(job.jobId, { phase: "BINDING", threadId: 42, createdAt: Date.now() - 130_000 });
  return { ...f, job };
}

test("a stuck prepared binding stops after its retry budget and delayed deliveries stay stopped", async t => {
  const f = await preparedPausedFixture();
  let failures = 0, attempts = 0;
  t.mock.method(f.plane as any, "allocationUi", () => ({ allocationFailure: async () => { failures++; } }));
  t.mock.method(f.plane as any, "advance", async () => { attempts++; throw new Error("worker_unavailable"); });
  await (f.plane as any).advanceSafely(f.job.jobId);
  await (f.plane as any).advanceSafely(f.job.jobId);
  const paused = f.store.job(f.job.jobId)!;
  assert.equal(paused.phase, "FAILED");
  assert.equal(paused.cleanupPhase, "BINDING");
  assert.equal(paused.threadId, 42);
  assert.equal(paused.serviceId, "owned-service");
  assert.equal(paused.volumeId, "owned-volume");
  assert.equal(attempts, 0);
  assert.equal(failures, 1);
  assert.ok(!f.store.pendingJobs().some(job => job.jobId === paused.jobId));
});

test("Cancel fences prepared allocation progress and Retry resumes the same Topic and worker", async t => {
  const f = await preparedPausedFixture();
  t.mock.method(f.plane as any, "advance", async () => { throw new Error("unexpected_progress"); });
  await (f.plane as any).cancelAllocation(f.job.jobId);
  await (f.plane as any).advanceSafely(f.job.jobId);
  assert.equal(f.store.job(f.job.jobId)!.phase, "FAILED");
  await (f.plane as any).ui().deps.resumeAllocation(f.job.jobId);
  const resumed = f.store.job(f.job.jobId)!;
  assert.equal(resumed.phase, "BINDING");
  assert.equal(resumed.threadId, 42);
  assert.equal(resumed.workerId, f.job.workerId);
  assert.equal(resumed.generation, f.job.generation);
  assert.equal(resumed.volumeId, "owned-volume");
  assert.ok(resumed.createdAt! > Date.now() - 5_000);
  assert.deepEqual(f.queued.at(-1), { jobId: f.job.jobId });
});

test("a delayed Cancel cannot delete a successfully bound Topic", async t => {
  const f = await preparedPausedFixture();
  f.store.bindTopic(f.job.jobId, 42, "session");
  let deleted = false;
  t.mock.method(f.plane as any, "deleteTopic", async () => { deleted = true; });
  await (f.plane as any).cancelAllocation(f.job.jobId);
  assert.equal(f.store.job(f.job.jobId)!.phase, "BOUND");
  assert.equal(deleted, false);
});

test("Cancel retires the failed runtime and recycles its existing service and volume once", async t => {
  const f = await preparedPausedFixture();
  // This fixture has not rotated yet; cancel uses its unbound identity.
  f.store.configureJob(f.job.jobId, { threadId: undefined });
  const secret = "s".repeat(64);
  f.store.ready(f.job.workerId, 1, await encryptCredential(btoa("k".repeat(32)), "node:worker-01:1", secret));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let retirements = 0;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.operation, "retire");
    assert.equal(body.payload.sanitize, true);
    retirements++;
    const reply = await signEnvelope({ ...body, payload: { ok: true, result: { retired: true, sanitized: true } } }, secret);
    return new Response(reply.body, { headers: { "x-node-signature": reply.signature } });
  };
  await (f.plane as any).cancelAllocation(f.job.jobId);
  await (f.plane as any).cleanupCancelledAllocation(f.job.jobId);
  await (f.plane as any).cleanupCancelledAllocation(f.job.jobId);
  const recycled = f.store.jobs().find(job => job.requestId === "fleet-recycle:worker-01:2")!;
  assert.equal(recycled.serviceId, "owned-service");
  assert.equal(recycled.volumeId, "owned-volume");
  assert.equal(retirements, 1);
  assert.equal(f.store.worker("worker-01")!.state, "RECOVERING");
  assert.equal(f.store.worker("worker-01")!.credential, undefined);
});

test("cancelled allocation recovery does not refence after recycling was persisted", async () => {
  const f = await preparedPausedFixture();
  await (f.plane as any).cancelAllocation(f.job.jobId);
  const worker = f.store.fenceWorker(f.job.workerId);
  const recycle = f.store.prepareWorkerReuse(worker.workerId, worker.generation, f.job.jobId);
  await (f.plane as any).cleanupCancelledAllocation(f.job.jobId);
  assert.equal(f.store.worker(worker.workerId)!.generation, worker.generation);
  assert.deepEqual(f.queued.at(-1), { jobId: recycle.jobId });
});

test("an old Cancel button cannot delete a newer Topic on the reused worker", async t => {
  const f = await preparedPausedFixture();
  await (f.plane as any).cancelAllocation(f.job.jobId);
  const worker = f.store.fenceWorker(f.job.workerId);
  f.store.prepareWorkerReuse(worker.workerId, worker.generation, f.job.jobId);
  f.store.ready(worker.workerId, worker.generation, "synthetic");
  const next = f.store.reservePreparedAllocation("next-chat", -100);
  f.store.bindTopic(next.jobId, 43, "next-session");
  let deleted = false;
  t.mock.method(f.plane as any, "deleteTopic", async () => { deleted = true; });
  await (f.plane as any).cancelAllocation(f.job.jobId);
  assert.equal(deleted, false);
  assert.equal(f.store.job(next.jobId)!.phase, "BOUND");
});

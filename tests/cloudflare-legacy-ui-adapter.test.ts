import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type FleetTopic, type SqlDatabase } from "../src/cloudflare/control-store.js";
import { LegacyUiAdapter } from "../src/cloudflare/legacy-ui-adapter.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = { exec: (q, ...v) => db.prepare(q).all(...v) as never };
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const store = new ControlStore(sql, tx);
  store.setGlobal(
    {
      configuration: { runtime: { model: "opencode/big-pickle", agent: "build" } },
      defaults: { compactOutputMode: true, topicDefaults: { promptQueueEnabled: false } },
      credentialReferences: [{ id: "provider:test", configured: true }],
      secretValue: "must-not-leak",
    },
    "hash-1",
  );
  const topic: FleetTopic = {
    chatId: -1001,
    threadId: 77,
    workerId: "worker-1",
    generation: 3,
    sessionId: "session-1",
    state: "ACTIVE",
  };
  sql.exec("INSERT INTO topics VALUES(?,?,?,?)", topic.chatId, topic.threadId, topic.workerId, JSON.stringify(topic));
  sql.exec(
    "INSERT INTO ui_state VALUES(?,?)",
    `topic:${topic.chatId}:${topic.threadId}:${topic.generation}`,
    JSON.stringify({ model: "anthropic/claude-sonnet", agent: "plan", variant: "high" }),
  );
  const commits: Array<{ revision: number; data: Record<string, unknown> }> = [];
  const rpcCalls: Array<{ operation: string; payload: unknown }> = [];
  const adapter = new LegacyUiAdapter({
    sql,
    store,
    botVersion: "0.26.2",
    coreVersion: "1.18.33-bot.13-pre.25",
    rpc: async (_topic, operation, payload) => {
      rpcCalls.push({ operation, payload });
      return { ok: true } as never;
    },
    commitGlobal: async (data, expectedRevision) => {
      commits.push({ revision: expectedRevision, data });
      store.setGlobal(data, "hash-next", expectedRevision);
    },
  });
  return { adapter, store, sql, topic, commits, rpcCalls };
}

test("legacy UI adapter translates canonical global/topic state without exposing secret values", async () => {
  const f = fixture();
  const status = await f.adapter.getMainStatus();
  assert.deepEqual(status, {
    botVersion: "0.26.2",
    coreVersion: "1.18.33-bot.13-pre.25",
    model: "opencode/big-pickle",
    agent: "build",
  });
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);

  assert.deepEqual(f.adapter.getTopicSelection(f.topic), {
    compactOutputMode: true,
    promptQueueEnabled: false,
    model: "anthropic/claude-sonnet",
    agent: "plan",
    variant: "high",
  });

  f.adapter.setTopicSelection(f.topic, { model: "openai/gpt-5" });
  assert.equal(f.adapter.getTopicSelection(f.topic).model, "openai/gpt-5");
});

test("legacy UI adapter rejects stale topic generations before state or RPC mutation", async () => {
  const f = fixture();
  const stale = { ...f.topic, generation: 2 };
  assert.throws(() => f.adapter.setTopicSelection(stale, { agent: "build" }), /stale_generation/);
  await assert.rejects(f.adapter.rpc(stale, "session.get"), /stale_generation/);
  assert.equal(f.rpcCalls.length, 0);
});

test("legacy UI adapter commits global snapshots with the exact expected revision", async () => {
  const f = fixture();
  const snapshot = f.adapter.getGlobalSnapshot();
  assert.equal(snapshot?.revision, 1);
  const next = structuredClone(snapshot!.data);
  (next.configuration as any).runtime.model = "openai/gpt-5";
  await f.adapter.commitGlobal(snapshot!.revision, next);
  assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0]?.revision, 1);
  assert.equal((f.store.global()?.data.configuration as any).runtime.model, "openai/gpt-5");
});

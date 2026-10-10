import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CloudBotUi } from "../src/cloudflare/bot-ui.js";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { CloudTelegram } from "../src/cloudflare/telegram.js";

function fixture(configured = "v1.18.33-bot.13-pre.25", observed = configured) {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (q: string, ...args: unknown[]) => db.prepare(q).all(...(args as never[])) as never,
  };
  const store = new ControlStore(sql, (fn) => fn());
  store.setGlobal({ configuration: { runtime: { model: "opencode/big-pickle" } } }, "hash");
  store.putBackend({
    backendId: "a",
    workspaceId: "workspace",
    credential: "synthetic",
    desiredMaximumWorkers: 10,
    maxWorkersPerProject: 5,
    region: "europe-west4",
    enabled: true,
  });
  const job = store.reserveTopicAllocation("topic", -100, 42);
  store.ready(job.workerId, 1, "synthetic");
  store.bindTopic(job.jobId, 42, "session");
  sql.exec(
    "INSERT INTO ui_state(key,data) VALUES(?,?)",
    "legacy:model:catalog",
    JSON.stringify({
      at: Date.now(),
      providers: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "big-pickle": {
              name: "Big Pickle",
              modalities: { input: ["text"], output: ["text"] },
              capabilities: { tools: true, reasoning: true },
            },
          },
        },
      ],
    }),
  );
  if (observed) store.saveObservation(job.workerId, 1, { runtimeVersion: observed });
  const sent: Array<{ method: string; payload: any }> = [];
  const admitted: Array<{ topic: unknown; request: string }> = [];
  const ui = new CloudBotUi({
    sql,
    store,
    coreVersion: configured,
    telegram: new CloudTelegram("synthetic", async (input, init) => {
      sent.push({
        method: String(input).split("/").at(-1)!,
        payload: JSON.parse(String(init?.body)),
      });
      return Response.json({ ok: true, result: { message_id: 9 } });
    }),
    newTopic: async () => {
      throw new Error("unexpected_allocation");
    },
    deleteTopic: async () => {
      throw new Error("unexpected_delete");
    },
    rpc: async <T>() => [] as T,
    global: async () => {
      throw new Error("unexpected_global_change");
    },
    compact: async (topic, request) => {
      admitted.push({ topic, request });
    },
  });
  const update = (text: string, id = 1) =>
    ui.handle(
      {
        update_id: id,
        message: { chat: { id: -100 }, from: { id: 7 }, message_thread_id: 42, text },
      },
      id,
    );
  const callback = (data: string, id = 2, actor = 7, thread = 42) =>
    ui.handle(
      {
        update_id: id,
        callback_query: {
          id: String(id),
          from: { id: actor },
          data,
          message: {
            message_id: ui.panelIdentity(7, -100, 42, 1).messageId,
            chat: { id: -100 },
            message_thread_id: thread,
          },
        },
      },
      id,
    );
  const compactButton = () =>
    sent
      .flatMap((x) => x.payload.reply_markup?.inline_keyboard?.flat() ?? [])
      .find((b: any) => /compact context/i.test(b.text));
  return { db, store, sent, admitted, update, callback, compactButton };
}

test("Context Health admits context compaction once using a stable scoped queue identity", async () => {
  const f = fixture();
  await f.update("/context");
  const button = f.compactButton();
  assert.ok(button);
  await f.callback(button.callback_data);
  await f.callback(button.callback_data, 3);
  assert.equal(f.admitted.length, 1);
  assert.equal(f.admitted[0]?.request, "telegram_compact_2");
  assert.equal((f.admitted[0]?.topic as any).sessionId, "session");
});

test("context compaction remains hidden until configured and observed worker versions support it", async () => {
  for (const [configured, observed] of [
    ["v1.18.33-bot.13-pre.24", "v1.18.33-bot.13-pre.25"],
    ["v1.18.33-bot.13-pre.25", "v1.18.33-bot.13-pre.24"],
    ["v1.18.33-bot.13-pre.25", ""],
  ]) {
    const f = fixture(configured, observed);
    await f.update("/context");
    assert.equal(f.compactButton(), undefined);
    assert.equal(f.admitted.length, 0);
  }
});

test("compaction callback refuses changed generation and another actor or Topic", async () => {
  const f = fixture();
  await f.update("/context");
  const button = f.compactButton();
  assert.ok(button);
  await f.callback(button.callback_data, 2, 8);
  await f.callback(button.callback_data, 3, 7, 43);
  f.store.fenceTopic(-100, 42);
  await f.callback(button.callback_data, 4);
  assert.equal(f.admitted.length, 0);
});

test("compact slash remains presentation only and hidden compaction action cannot bypass its callback", async () => {
  const f = fixture();
  await f.update("/compact");
  await f.update("/context_compact", 2);
  assert.equal(f.admitted.length, 0);
});

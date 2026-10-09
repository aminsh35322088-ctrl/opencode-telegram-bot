import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CloudBotUi } from "../src/cloudflare/bot-ui.js";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { CloudTelegram } from "../src/cloudflare/telegram.js";
function fixture(t: { after: (f: () => void) => void }) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = {
    exec: (q: string, ...v: unknown[]) => db.prepare(q).all(...(v as never[])) as never,
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
          models: { other: { name: "Other" }, "big-pickle": { name: "Big Pickle" } },
        },
      ],
    }),
  );
  const sent: Array<{ method: string; payload: any }> = [];
  const rpc: string[] = [];
  let nextId = 100,
    missing = false,
    failTransport = false;
  let heldEdit: Promise<void> | undefined, releaseEdit: (() => void) | undefined;
  const deps = {
    sql,
    store,
    coreVersion: "v1.18.33-bot.13-pre.25",
    allowedUserId: "7",
    telegram: new CloudTelegram("synthetic", async (input, init) => {
      const method = String(input).split("/").at(-1)!,
        payload = JSON.parse(String(init?.body));
      sent.push({ method, payload });
      if (failTransport && method === "sendMessage") {
        failTransport = false;
        let heldEdit: Promise<void> | undefined, releaseEdit: (() => void) | undefined;
        throw new Error("network");
      }
      if (heldEdit && method === "editMessageText") {
        const pending = heldEdit;
        heldEdit = undefined;
        await pending;
      }
      if (missing && method === "editMessageText") {
        missing = false;
        failTransport = false;
        return Response.json(
          { ok: false, error_code: 400, description: "Bad Request: message to edit not found" },
          { status: 400 },
        );
      }
      return Response.json({
        ok: true,
        result: { message_id: method === "sendMessage" ? ++nextId : (payload.message_id ?? 100) },
      });
    }),
    newTopic: async () => {
      rpc.push("new");
      return job;
    },
    deleteTopic: async () => {
      rpc.push("delete");
    },
    rpc: async <T>(_topic: unknown, op: string) => {
      rpc.push(op);
      if (op === "models.list") {
        const row = db.prepare("SELECT data FROM ui_state WHERE key='legacy:model:catalog'").get()!;
        return { providers: JSON.parse(String(row.data)).providers } as T;
      }
      return (op === "model.inspect" ? { connected: true, available: true } : op === "status" ? null : []) as T;
    },
    global: async () => {
      rpc.push("global");
    },
  };
  let ui = new CloudBotUi(deps),
    seq = 0;
  const update = (text: string, thread = 0, actor = 7) =>
    ui.handle(
      {
        update_id: ++seq,
        message: {
          message_id: seq,
          chat: { id: -100 },
          from: { id: actor },
          ...(thread ? { message_thread_id: thread } : {}),
          text,
        },
      },
      seq,
    );
  const callback = (data: string, thread = 0, actor = 7, messageId?: number) =>
    ui.handle(
      {
        update_id: ++seq,
        callback_query: {
          id: String(seq),
          from: { id: actor },
          data,
          message: {
            message_id: messageId ?? nextId,
            chat: { id: -100 },
            ...(thread ? { message_thread_id: thread } : {}),
          },
        },
      },
      seq,
    );
  const button = (label: string) =>
    sent
      .flatMap((x) => x.payload.reply_markup?.inline_keyboard?.flat() ?? [])
      .find((b: any) => b.text.includes(label));
  return {
    db,
    ui,
    store,
    sent,
    rpc,
    update,
    callback,
    button,
    scoped: (actor = 7, thread = 42, generation = 1) =>
      ui.forPanel(actor, -100, thread, generation),
    restart: () => {
      ui = new CloudBotUi(deps);
    },
    holdNextEdit: () => {
      heldEdit = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
      return () => releaseEdit!();
    },
    failNextSend: () => {
      failTransport = true;
    },
    missing: () => {
      missing = true;
    },
  };
}

function latestPanel(f: ReturnType<typeof fixture>) {
  return f.sent.filter((x) => ["sendMessage", "editMessageText"].includes(x.method)).at(-1)!;
}
function latestInlineButton(f: ReturnType<typeof fixture>, label: string) {
  const button = f.sent
    .flatMap((x) => x.payload.reply_markup?.inline_keyboard?.flat() ?? [])
    .filter((b: any) => String(b.text).includes(label))
    .at(-1);
  assert.ok(button, `Missing ${label} on current inline panel`);
  return button;
}
function latestReplyButton(f: ReturnType<typeof fixture>, label: string) {
  const button = f.sent
    .flatMap((x) => x.payload.reply_markup?.keyboard?.flat() ?? [])
    .filter((b: any) => String(b.text).includes(label))
    .at(-1);
  assert.ok(button, `Missing ${label} on current ReplyKeyboard`);
  return button;
}
function assertScopedTopicMarkup(f: ReturnType<typeof fixture>) {
  for (const item of f.sent.filter((x) => x.payload.reply_markup?.keyboard)) {
    assert.equal(item.payload.message_thread_id, 42);
    assert.equal(item.payload.reply_markup.inline_keyboard, undefined);
  }
  const activeCallbacks = f.db.prepare("SELECT thread FROM ui_callbacks").all() as Array<{ thread: number }>;
  assert.ok(activeCallbacks.every((row) => row.thread === 42));
}

test("every idle Topic ReplyKeyboard control routes to its own scoped behavior", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  assert.equal(f.sent.filter((x) => x.payload.reply_markup?.keyboard).at(-1)!.payload.message_thread_id, 42);
  assertScopedTopicMarkup(f);
  await f.update(latestReplyButton(f, "Compact: OFF").text, 42);
  assert.equal(f.scoped().options(f.store.topics()[0]!).compact, true);
  await f.update(latestReplyButton(f, "Compact: ON").text, 42);
  assert.equal(f.scoped().options(f.store.topics()[0]!).compact, false);
  await f.update(latestReplyButton(f, "🧠").text, 42);
  assert.match(latestPanel(f).payload.text, /Model Center/i);
  await f.update("/keyboard", 42);
  await f.update(latestReplyButton(f, "Topic Settings").text, 42);
  assert.match(latestPanel(f).payload.text, /Topic Settings/);
  await f.update("/keyboard", 42);
  await f.update(latestReplyButton(f, "Delete Chat").text, 42);
  assert.match(latestPanel(f).payload.text, /Delete Chat/);
  assert.deepEqual(f.rpc, []);
  assertScopedTopicMarkup(f);
});

test("Pause, Resume, and Abort ReplyKeyboard controls target only the Topic active run", async (t) => {
  const f = fixture(t);
  f.store.enqueue(-100, 42, "run", "question");
  f.store.startNext(-100, 42);
  await f.update("/keyboard", 42);
  await f.update(latestReplyButton(f, "Pause").text, 42);
  assert.deepEqual(f.rpc, ["pause"]);
  assert.equal(f.scoped().options(f.store.topics()[0]!).paused, true);
  await f.update(latestReplyButton(f, "Resume").text, 42);
  assert.deepEqual(f.rpc, ["pause", "resume"]);
  assert.equal(f.scoped().options(f.store.topics()[0]!).paused, false);
  await f.update(latestReplyButton(f, "Abort").text, 42);
  assert.deepEqual(f.rpc, ["pause", "resume", "stop", "status"]);
  assert.equal(f.store.activeRuns(-100, 42).length, 0);
  assertScopedTopicMarkup(f);
});

test("Topic ReplyKeyboard text cannot execute from General or another Topic", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  const compact = latestReplyButton(f, "Compact: OFF").text;
  await f.update(compact, 0);
  await f.update(compact, 99);
  assert.equal(f.scoped().options(f.store.topics()[0]!).compact, false);
  assert.deepEqual(f.rpc, []);
});

for (const method of ["ready", "runKeyboard"] as const) {
  test(`${method} always scopes the ReplyKeyboard to its AI Topic`, async (t) => {
    const f = fixture(t);
    const topic = f.store.topics()[0]!;
    if (method === "ready") await f.ui.ready(topic);
    else await f.ui.runKeyboard(topic, "background-run", true);
    const keyboard = f.sent.filter((x) => x.payload.reply_markup?.keyboard).at(-1)!;
    assert.equal(keyboard.payload.message_thread_id, 42);
    assertScopedTopicMarkup(f);
  });
}

for (const alias of ["/new_chat", "/sessions"]) {
  test(`${alias} cannot invoke General-only navigation from an AI Topic`, async (t) => {
    const f = fixture(t);
    await f.update(alias, 42);
    assert.deepEqual(f.rpc, []);
    assert.ok(f.sent.filter((x) => ["sendMessage", "editMessageText"].includes(x.method)).every((x) => x.payload.message_thread_id === 42));
    assert.match(latestPanel(f).payload.text, /General \/ ALL/);
  });
}

test("General with explicit thread 1 discards unsolicited input and does not inherit a Topic form", async (t) => {
  const f = fixture(t);
  await f.update("/rename", 42);
  f.sent.length = 0;
  await f.update("random conversation", 1);
  assert.deepEqual(f.rpc, []);
  assert.equal(f.sent.filter((x) => ["sendMessage", "editMessageText"].includes(x.method)).length, 0);
  assert.equal(f.sent.filter((x) => x.method === "deleteMessage").length, 1);
});

test("Delete Chat needs confirmation and retires only its Topic", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  await f.update(latestReplyButton(f, "Delete Chat").text, 42);
  assert.deepEqual(f.rpc, []);
  const confirm = latestInlineButton(f, "Delete Chat").callback_data;
  await f.callback(confirm, 0);
  assert.deepEqual(f.rpc, []);
  await f.callback(confirm, 42);
  assert.deepEqual(f.rpc, ["delete"]);
  assert.deepEqual(f.sent.find((x) => x.method === "deleteForumTopic")?.payload, {
    chat_id: -100,
    message_thread_id: 42,
  });
  await f.callback(confirm, 42);
  assert.deepEqual(f.rpc, ["delete"]);
});


test("Model Center selection refreshes the Topic ReplyKeyboard with the newly selected model", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  const originalModelButton = latestReplyButton(f, "🧠").text;
  await f.update(originalModelButton, 42);
  await f.callback(latestInlineButton(f, "Browse providers").callback_data, 42);
  await f.callback(latestInlineButton(f, "opencode").callback_data, 42);
  await f.callback(latestInlineButton(f, "Other").callback_data, 42);
  const updated = latestReplyButton(f, "🧠").text;
  assert.notEqual(updated, originalModelButton);
  assert.match(updated, /Other|other/i);
  assert.equal(f.store.activeRuns(-100, 42).length, 0);
});

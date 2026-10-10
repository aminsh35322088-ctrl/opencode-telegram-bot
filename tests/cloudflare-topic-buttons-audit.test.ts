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
          name: "OpenCode",
          models: {
            other: {
              name: "Other",
              modalities: { input: ["text", "image"], output: ["text"] },
              capabilities: { tools: true, reasoning: true },
            },
            "big-pickle": {
              name: "Big Pickle",
              modalities: { input: ["text", "image"], output: ["text"] },
              capabilities: { tools: true, reasoning: true },
            },
          },
        },
      ],
    }),
  );
  const sent: Array<{ method: string; payload: any }> = [];
  const rpc: string[] = [];
  let nextId = 100,
    missing = false,
    failTransport = false,
    deleteRejects = 0;
  const rejectedDeleteIds = new Set<number>();
  const deleted = new Set<number>();
  let heldEdit: Promise<void> | undefined, releaseEdit: (() => void) | undefined;
  let heldDelete: Promise<void> | undefined, releaseDelete: (() => void) | undefined;
  const background: Promise<unknown>[] = [];
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
      if (heldDelete && method === "deleteMessage") {
        const pending = heldDelete;
        heldDelete = undefined;
        await pending;
      }
      if (method === "deleteMessage" && rejectedDeleteIds.delete(Number(payload.message_id))) {
        return Response.json(
          { ok: false, error_code: 400, description: "Bad Request: not enough rights to delete messages" },
          { status: 400 },
        );
      }
      if (deleteRejects > 0 && method === "deleteMessage") {
        deleteRejects--;
        return Response.json(
          { ok: false, error_code: 400, description: "Bad Request: not enough rights to delete messages" },
          { status: 400 },
        );
      }
      if (method === "deleteMessage") deleted.add(Number(payload.message_id));
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
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
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
    deleted,
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
    rejectNextDeletes: (count = 1) => {
      deleteRejects = count;
    },
    rejectDeleteMessage: (messageId: number) => {
      rejectedDeleteIds.add(messageId);
    },
    holdNextDelete: () => {
      heldDelete = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      return () => releaseDelete!();
    },
    drainBackground: async () => {
      while (background.length) await background.shift();
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
    .flatMap((x) => [
      ...(x.payload.reply_markup?.keyboard?.flat() ?? []),
      ...(x.payload.reply_markup?.inline_keyboard?.flat() ?? []),
    ])
    .filter((b: any) => String(b.text).includes(label))
    .at(-1);
  assert.ok(button, `Missing ${label} on current Topic controls`);
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

test("managed AI Topic uses a real dynamic ReplyKeyboard while All stays callback-only", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  const reply = f.sent.find((x) => x.payload.reply_markup?.keyboard);
  assert.ok(reply);
  assert.equal(reply.payload.message_thread_id, 42);
  assert.equal(reply.payload.reply_markup.resize_keyboard, true);
  assert.equal(reply.payload.reply_markup.is_persistent, undefined);
  assert.equal(reply.payload.reply_markup.inline_keyboard, undefined);
  assert.equal(f.sent.some((x) => x.payload.reply_markup?.remove_keyboard === true), false);
  assert.deepEqual(
    reply.payload.reply_markup.keyboard.map((row: any[]) => row.map((button) => button.text)),
    [
      ["📦 Compact: OFF"],
      ["🧠 Big Pickle"],
      ["🗑️ Delete Chat", "⚙️ Topic Settings"],
    ],
  );

  await f.update("📦 Compact: OFF", 42);
  assert.equal(f.scoped().options(f.store.topics()[0]!).compact, true);
  const compact = f.sent.filter((x) => x.payload.reply_markup?.keyboard).at(-1)!;
  assert.match(String(compact.payload.text), /Compact: ON/);
  assert.equal(latestReplyButton(f, "Compact: ON").text, "📦 Compact: ON");

  await f.update("🧠 Big Pickle", 42);
  assert.match(latestPanel(f).payload.text, /Model Center/i);

  await f.update("⚙️ Topic Settings", 42);
  assert.match(latestPanel(f).payload.text, /Topic Settings/);
});

test("legacy exact Topic control text is still consumed and deleted before dispatch", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  const modelText = latestReplyButton(f, "🧠").text;
  f.sent.length = 0;
  const release = f.holdNextDelete();
  const pending = f.update(modelText, 42);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(f.sent.some((entry) => entry.method === "deleteMessage" && entry.payload.message_id === 2));
  assert.equal(
    f.sent.some((entry) => /MODEL CENTER/i.test(String(entry.payload.text ?? ""))),
    false,
  );
  release();
  await pending;
  await f.drainBackground();
  assert.match(latestPanel(f).payload.text, /MODEL CENTER/i);
});

test("legacy dynamic Topic control text never becomes a model prompt", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  const modelText = latestReplyButton(f, "🧠").text;
  f.db.prepare("DELETE FROM ui_state WHERE key LIKE 'reply-keyboard:%'").run();
  f.sent.length = 0;
  await f.update(modelText, 42);
  assert.ok(f.sent.some((entry) => entry.method === "deleteMessage"));
  assert.equal([...f.db.prepare("SELECT request FROM runs").all()].length, 0);
});

test("managed Topic controls expose no Pause Resume or Abort fallback", async (t) => {
  const f = fixture(t);
  f.store.enqueue(-100, 42, "run", "question");
  f.store.startNext(-100, 42);
  await f.update("/keyboard", 42);
  const labels = f.sent.flatMap((entry) =>
    (entry.payload.reply_markup?.keyboard?.flat() ?? []).map((button: any) => String(button.text)),
  );
  assert.equal(labels.some((label) => /Pause|Resume|Abort/.test(label)), false);
});

test("manual Telegram Topics ignore ReplyKeyboard-looking text completely", async (t) => {
  const f = fixture(t);
  await f.update("📦 Compact: OFF", 99);
  assert.equal(f.scoped().options(f.store.topics()[0]!).compact, false);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.rpc, []);
});

test("ready publishes the first Topic message with ReplyKeyboard and model capability summary", async (t) => {
  const f = fixture(t);
  const topic = f.store.topics()[0]!;
  await f.ui.ready(topic);
  const ready = f.sent.filter((x) => x.method === "sendMessage").at(-1)!;
  assert.equal(ready.payload.message_thread_id, 42);
  assert.ok(ready.payload.reply_markup?.keyboard);
  assert.match(String(ready.payload.text), /Chat #01 created/);
  for (const label of ["Chat", "Vision", "Reasoning", "Voice → Text", "Image AI", "Text → Voice", "Tool Call", "Agent Mode"])
    assert.match(String(ready.payload.text), new RegExp(label.replace("→", "→")));
});

test("run state refresh does not spam a new ReplyKeyboard because Native Stop owns execution control", async (t) => {
  const f = fixture(t);
  const topic = f.store.topics()[0]!;
  await f.ui.runKeyboard(topic, "background-run", true);
  assert.equal(f.sent.filter((x) => x.payload.reply_markup?.keyboard).length, 0);
});

for (const alias of ["/new_chat", "/sessions"]) {
  test(`${alias} cannot invoke General-only navigation from an AI Topic`, async (t) => {
    const f = fixture(t);
    await f.update(alias, 42);
    assert.deepEqual(f.rpc, []);
    assert.ok(f.sent.filter((x) => ["sendMessage", "editMessageText"].includes(x.method)).every((x) => x.payload.message_thread_id === 42));
    assert.match(latestPanel(f).payload.text, /General \/ ALL/);
  });
}

test("General with explicit thread 1 preserves unsolicited text and does not inherit a Topic form", async (t) => {
  const f = fixture(t);
  await f.update("/rename", 42);
  f.sent.length = 0;
  await f.update("random conversation", 1);
  assert.deepEqual(f.rpc, []);
  assert.equal(
    f.sent.filter((x) => x.method === "sendMessage" && /Open an AI Topic/.test(String(x.payload.text))).length,
    1,
  );
  assert.equal(f.sent.filter((x) => x.method === "deleteMessage").length, 0);
});

test("fresh ReplyKeyboard menus replace the previous Topic panel instead of editing it", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  await f.update(latestReplyButton(f, "🧠").text, 42);
  const modelPanel = f.scoped().panelIdentity(7, -100, 42, 1).messageId!;
  assert.ok(modelPanel);

  f.sent.length = 0;
  await f.update(latestReplyButton({ ...f, sent: [{ method: "sendMessage", payload: { reply_markup: { keyboard: [[{ text: "🗑️ Delete Chat" }]] } } }] } as any, "Delete Chat").text, 42);
  const deletePanel = f.scoped().panelIdentity(7, -100, 42, 1).messageId!;
  assert.ok(deletePanel);
  assert.notEqual(deletePanel, modelPanel);
  assert.ok(f.deleted.has(modelPanel));
  assert.match(String(f.sent.find((entry) => entry.payload.reply_markup?.inline_keyboard)?.payload.text ?? ""), /Delete Chat/i);
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


test("model selection retries a transient panel delete and leaves no Model Center behind", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  await f.update(latestReplyButton(f, "🧠").text, 42);
  await f.callback(latestInlineButton(f, "Browse providers").callback_data, 42);
  await f.callback(latestInlineButton(f, "OpenCode").callback_data, 42);
  const panelId = f.scoped().panelIdentity(7, -100, 42, 1).messageId!;
  assert.ok(panelId);

  f.rejectDeleteMessage(panelId);
  await f.callback(latestInlineButton(f, "Other").callback_data, 42);
  await f.drainBackground();

  assert.ok(f.deleted.has(panelId), "transient panel deletion should be retried in the background");
  const refreshedPanel = f.scoped().panelIdentity(7, -100, 42, 1).messageId;
  assert.equal(refreshedPanel, undefined);
  assert.doesNotMatch(String(latestPanel(f).payload.text ?? ""), /MODEL CENTER/i);
});

test("Model Center selection refreshes the Topic inline controls with the newly selected model", async (t) => {
  const f = fixture(t);
  await f.update("/keyboard", 42);
  const originalModelButton = latestReplyButton(f, "🧠").text;
  await f.update(originalModelButton, 42);
  await f.callback(latestInlineButton(f, "Browse providers").callback_data, 42);
  await f.callback(latestInlineButton(f, "OpenCode").callback_data, 42);
  const panelId = f.scoped().panelIdentity(7, -100, 42, 1).messageId;
  assert.ok(panelId);
  await f.callback(latestInlineButton(f, "Other").callback_data, 42);
  const updatedMessage = f.sent.filter((entry) => entry.payload.reply_markup?.keyboard).at(-1)!;
  const updated = latestReplyButton(f, "🧠").text;
  assert.notEqual(updated, originalModelButton);
  assert.match(updated, /Other|other/i);
  assert.match(String(updatedMessage.payload.text), /Model changed/);
  for (const label of ["Chat", "Vision", "Reasoning", "Voice → Text", "Image AI", "Text → Voice", "Tool Call", "Agent Mode"])
    assert.ok(String(updatedMessage.payload.text).includes(label), `missing ${label}`);
  assert.ok(f.sent.some((entry) => entry.method === "deleteMessage" && entry.payload.message_id === panelId));
  const refreshedPanel = f.scoped().panelIdentity(7, -100, 42, 1).messageId;
  assert.equal(refreshedPanel, undefined);
  assert.equal(f.store.activeRuns(-100, 42).length, 0);
});

test("AI Topic controls stay Topic-scoped ReplyKeyboard without forcing persistent mode", async (t) => {
  const f = fixture(t);
  const topic = f.store.topics()[0]!;
  await f.scoped().keyboard(topic.chatId, topic, "✅ Ready");
  const entry = f.sent.find((item) => item.payload.reply_markup?.keyboard)!;
  assert.ok(entry);
  assert.equal(entry.payload.message_thread_id, 42);
  assert.equal(entry.payload.reply_markup.is_persistent, undefined);
  assert.equal(entry.payload.reply_markup.inline_keyboard, undefined);
  assert.equal(f.sent.some((item) => item.payload.reply_markup?.remove_keyboard), false);
});

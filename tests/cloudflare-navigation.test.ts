import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CloudBotUi } from "../src/cloudflare/bot-ui.js";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { CloudTelegram } from "../src/cloudflare/telegram.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
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
  const replyMessages = new Set<number>();
  let enforceKeyboardEdits = false;
  let nextId = 100,
    missing = false,
    failTransport = false,
    uneditable = false;
  let heldEdit: Promise<void> | undefined, releaseEdit: (() => void) | undefined;
  const deps = {
    sql,
    store,
    coreVersion: "v1.18.33-bot.13-pre.25",
    telegram: new CloudTelegram("synthetic", async (input, init) => {
      const method = String(input).split("/").at(-1)!,
        payload = JSON.parse(String(init?.body));
      sent.push({ method, payload });
      if (
        enforceKeyboardEdits &&
        ["editMessageText", "editMessageReplyMarkup"].includes(method) &&
        replyMessages.has(payload.message_id)
      ) {
        return Response.json(
          { ok: false, error_code: 400, description: "Bad Request: message can't be edited" },
          { status: 400 },
        );
      }
      if (method === "sendMessage" && payload.reply_markup?.remove_keyboard)
        replyMessages.add(nextId + 1);
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
      if (uneditable && method === "editMessageReplyMarkup") {
        uneditable = false;
        return Response.json(
          { ok: false, error_code: 400, description: "Bad Request: message can't be edited" },
          { status: 400 },
        );
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
      return [] as T;
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
    enforceKeyboardEditRules: () => {
      enforceKeyboardEdits = true;
    },
    failRetirement: () => {
      uneditable = true;
    },
    failNextSend: () => {
      failTransport = true;
    },
    missing: () => {
      missing = true;
    },
  };
}
test("home and every navigation command edit one panel across restart", async () => {
  const f = fixture();
  await f.update("/start");
  await f.update("/settings");
  f.restart();
  await f.update("/history");
  await f.update("/home");
  const sends = f.sent.filter((x) => x.method === "sendMessage");
  assert.equal(sends.length, 1);
  assert.ok(
    f.sent.filter((x) => x.method === "editMessageText").every((x) => x.payload.message_id === 101),
  );
});
test("harmless expired navigation reopens current panel without expiry dead end", async () => {
  const f = fixture();
  await f.update("/settings");
  const button = f.button("More")!;
  f.db.prepare("UPDATE ui_callbacks SET expires=0 WHERE id=?").run(button.callback_data.slice(3));
  await f.callback(button.callback_data);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
  assert.match(f.sent.at(-1)!.payload.text, /More Settings/);
  assert.equal(JSON.stringify(f.sent).includes("This menu has expired"), false);
});
test("harmless navigation double taps remain usable on the same panel", async () => {
  const f = fixture();
  await f.update("/settings");
  const button = f.button("More")!;
  await f.callback(button.callback_data);
  await f.callback(button.callback_data);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
  assert.equal(JSON.stringify(f.sent).includes("This menu has expired"), false);
});
test("destructive callback remains expired and cannot act from an old panel message", async () => {
  const f = fixture();
  await f.update("/delete_topic", 42);
  const button = f.button("🗑️")!;
  await f.callback(button.callback_data, 42, 7, 9999);
  assert.deepEqual(f.rpc, []);
  f.db.prepare("UPDATE ui_callbacks SET expires=0 WHERE id=?").run(button.callback_data.slice(3));
  await f.callback(button.callback_data, 42);
  assert.deepEqual(f.rpc, []);
});
test("navigation clears active form so ALL later input cannot mutate configuration", async () => {
  const f = fixture();
  await f.update("/model_edit");
  await f.update("/settings");
  await f.update("opencode/other");
  assert.deepEqual(f.rpc, []);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
});
test("ALL unsolicited text stays visible, gets Topic guidance, and never executes", async () => {
  const f = fixture();
  await f.update("hello");
  await f.update("another message");
  assert.deepEqual(f.rpc, []);
  assert.ok(
    f.sent.some(
      (x) => ["sendMessage", "editMessageText"].includes(x.method) && /Open an AI Topic/.test(String(x.payload.text)),
    ),
  );
  assert.equal(f.sent.filter((x) => x.method === "deleteMessage").length, 0);
});
test("wizard prompt and answer edit the same panel and preserve explicit form admission", async () => {
  const f = fixture();
  await f.update("/settings");
  await f.update("/model_edit");
  await f.update("opencode/other");
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
  assert.deepEqual(f.rpc, ["models.list", "global"]);
});
test("definitively deleted panel receives one replacement then edits its new identity", async () => {
  const f = fixture();
  await f.update("/start");
  f.missing();
  await f.update("/settings");
  await f.update("/history");
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 2);
  assert.equal(f.sent.at(-1)!.payload.message_id, 102);
});

test("a destructive callback replaced by navigation cannot execute from its old keyboard", async () => {
  const f = fixture();
  await f.update("/delete_topic", 42);
  const button = f.button("🗑️")!;
  await f.update("/settings", 42);
  await f.callback(button.callback_data, 42);
  assert.deepEqual(f.rpc, []);
});

test("run readiness keeps ReplyKeyboard scoped to the managed Topic while native Stop owns run control", async () => {
  const f = fixture();
  await f.update("/settings", 42);
  const topic = f.store.topics()[0]!;
  await f.scoped().ready(topic);
  f.store.enqueue(-100, 42, "run", "question");
  f.store.startNext(-100, 42);
  await f.scoped().runKeyboard(topic, "run", true);
  f.store.finishRun(-100, 42, "run");
  await f.scoped().runKeyboard(topic, "run", false);
  const reply = f.sent.filter((x) => x.payload.reply_markup?.keyboard);
  assert.ok(reply.length >= 1);
  assert.ok(reply.every((x) => x.payload.message_thread_id === 42));
  assert.equal(f.sent.some((x) => x.payload.reply_markup?.remove_keyboard), false);
  assert.doesNotMatch(JSON.stringify(reply), /Pause|Resume|Abort/);
  const callbackThreads = f.db.prepare("SELECT thread FROM ui_callbacks").all() as Array<{ thread: number }>;
  assert.ok(callbackThreads.every((row) => row.thread === 42));
});

test("legacy New Chat callback reopens home and never allocates", async () => {
  const f = fixture();
  await f.update("/start");
  await f.callback("main:new");
  await f.callback("main:new");
  assert.deepEqual(f.rpc, []);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
});

test("scoped New Chat callback cannot repeat allocation on a second update", async () => {
  const f = fixture();
  await f.update("/start");
  const button = f.button("New Chat")!;
  assert.match(button.callback_data, /^ui:/);
  await f.callback(button.callback_data);
  await f.callback(button.callback_data);
  assert.deepEqual(f.rpc, ["new"]);
});

test("ambiguous initial panel delivery cannot create a duplicate after restart", async () => {
  const f = fixture();
  f.failNextSend();
  await assert.rejects(f.update("/start"), /telegram_ambiguous/);
  f.restart();
  await assert.rejects(f.update("/settings"), /telegram_ambiguous/);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
});

test("panel receipts remain separate for actors while each actor edits its own message", async () => {
  const f = fixture();
  await f.update("/start", 0, 7);
  await f.update("/settings", 0, 8);
  await f.update("/history", 0, 7);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 2);
  assert.equal(f.sent.at(-1)!.payload.message_id, 101);
  assert.deepEqual(f.scoped(7, 0, 0).panelIdentity(7, -100, 0, 0), {
    messageId: 101,
    state: "DELIVERED",
  });
});

test("a missing harmless callback row recovers only from its actor's current panel", async () => {
  const f = fixture();
  await f.update("/settings");
  const button = f.button("More")!;
  f.db.prepare("DELETE FROM ui_callbacks WHERE id=?").run(button.callback_data.slice(3));
  await f.callback(button.callback_data, 0, 8);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
  await f.callback(button.callback_data);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
  assert.match(f.sent.at(-1)!.payload.text, /OpenCode/);
});

test("first navigation on a legacy main panel adopts its message instead of sending another", async () => {
  const f = fixture();
  await f.callback("main:settings", 0, 7, 777);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 0);
  assert.equal(f.sent.at(-1)!.method, "editMessageText");
  assert.equal(f.sent.at(-1)!.payload.message_id, 777);
});

test("legacy panel adoption cannot steal another actor's persisted message identity", async () => {
  const f = fixture();
  await f.callback("main:settings", 0, 7, 777);
  await f.callback("main:settings", 0, 8, 777);
  assert.equal(f.scoped(8, 0, 0).panelIdentity(8, -100, 0, 0).messageId, undefined);
});

test("a manually entered Topic rename records its source for automatic title fencing", async () => {
  const f = fixture();
  await f.update("/rename", 42);
  await f.update("My chosen name", 42);
  const row = f.db.prepare("SELECT data FROM ui_state WHERE key='topic:-100:42:1'").get()!;
  assert.equal(JSON.parse(String(row.data)).titleSource, "manual");
});

test("a late edit acknowledgement cannot invalidate the newer panel's callback ownership", async () => {
  const f = fixture();
  await f.update("/start");
  const release = f.holdNextEdit();
  const delayed = f.update("/settings");
  await f.update("/history");
  const button = f.sent
    .flatMap((x) => x.payload.reply_markup?.inline_keyboard?.flat() ?? [])
    .filter((b: any) => b.text.includes("New Chat"))
    .at(-1)!;
  release();
  await delayed;
  await f.callback(button.callback_data);
  assert.deepEqual(f.rpc, ["new"]);
});

test("History reopening another Topic restores its scoped ReplyKeyboard without changing panel identity", async () => {
  const f = fixture();
  await f.update("/settings", 42);
  await f.update("/history");
  const button = f.button("OpenCode · 42")!;
  assert.ok(button);
  await f.callback(button.callback_data);
  const firstPanel = f.scoped().panelIdentity(7, -100, 42, 1).messageId;
  assert.ok(firstPanel);
  await f.callback(button.callback_data);
  assert.equal(f.sent.some((x) => x.payload.reply_markup?.keyboard), true);
  assert.equal(f.scoped().panelIdentity(7, -100, 42, 1).messageId, firstPanel);
});

test("scoped UI errors edit the canonical panel rather than append an error message", async () => {
  const f = fixture();
  await f.update("/settings");
  await f.scoped(7, 0, 0).showError("Please retry.");
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
  assert.equal(f.sent.at(-1)!.method, "editMessageText");
  assert.equal(f.sent.at(-1)!.payload.message_id, 101);
});

test("migrated General navigation adopts the old Main and retires the old secondary menu", async () => {
  const f = fixture();
  f.db
    .prepare("INSERT INTO ui_state VALUES(?,?)")
    .run("legacy:main:-100", JSON.stringify({ messageId: 90, actorId: 7 }));
  f.db
    .prepare("INSERT INTO ui_state VALUES(?,?)")
    .run("legacy:menu:-100", JSON.stringify({ messageId: 91 }));
  await f.update("/settings");
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 0);
  assert.equal(f.sent.find((x) => x.method === "editMessageText")?.payload.message_id, 90);
  assert.equal(f.sent.find((x) => x.method === "deleteMessage")?.payload.message_id, 91);
  await f.update("/home");
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 0);
  assert.equal(f.sent.filter((x) => x.method === "editMessageText").at(-1)?.payload.message_id, 90);
});

test("expired restored Model Center navigation reopens safely on the same panel", async () => {
  const f = fixture();
  for (const label of ["Favorites", "Recent", "Browse providers"]) {
    f.sent.length = 0;
    await f.update("/model");
    const button = f.button(label)!;
    assert.ok(button);
    f.db.prepare("UPDATE ui_callbacks SET expires=0 WHERE id=?").run(button.callback_data.slice(3));
    f.sent.length = 0;
    await f.callback(button.callback_data);
    assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 0);
    assert.equal(JSON.stringify(f.sent).includes("expired"), false);
  }
  assert.deepEqual(f.rpc, []);
});

test("explicit General start retires the old panel, clears chat keyboard and creates one fresh panel", async () => {
  const f = fixture();
  await f.update("/start");
  const old = f.sent.find((x) => x.method === "sendMessage")!.payload;
  await f.update("/settings");
  const oldCallback = f.button("More")!.callback_data;
  await f.update("/start");
  const sends = f.sent.filter((x) => x.method === "sendMessage");
  assert.equal(sends.length, 2);
  assert.ok(sends[1]!.payload.reply_markup.inline_keyboard);
  assert.ok(
    f.sent.some((x) => x.method === "editMessageReplyMarkup" && x.payload.message_id === 101),
  );
  const before = f.sent.length;
  await f.callback(oldCallback, 0, 7, 101);
  assert.deepEqual(
    f.sent.slice(before).map((item) => item.method),
    ["answerCallbackQuery"],
  );
  assert.equal(old.message_thread_id, undefined);
});

test("GitHub and Tailscale menus expose a protected real account connection wizard on the same panel", async () => {
  const f = fixture();
  await f.update("/start");
  for (const integration of ["github", "tailscale"]) {
    await f.update("/" + integration);
    const button = f.sent
      .flatMap((item) => item.payload.reply_markup?.inline_keyboard?.flat() ?? [])
      .filter((item) => item.text === "🔗 Connect account")
      .at(-1);
    assert.ok(button);
    await f.callback(button.callback_data);
    const form = f.db.prepare("SELECT data FROM ui_state WHERE key='form:7:-100:0'").get()!;
    assert.equal(JSON.parse(String(form.data)).providerId, "integration." + integration);
    assert.equal(JSON.parse(String(form.data)).kind, "credential");
    await f.update("/cancel");
  }
  assert.equal(f.sent.filter((item) => item.method === "sendMessage").length, 1);
  assert.deepEqual(f.rpc, []);
});

test("replaying one explicit start after restart cannot create another panel", async () => {
  const f = fixture();
  const update = {
    update_id: 9000,
    message: { message_id: 9, chat: { id: -100 }, from: { id: 7 }, text: "/start" },
  };
  await f.scoped(7, 0, 0).handle(update, 9000);
  f.restart();
  await f.scoped(7, 0, 0).handle(update, 9000);
  assert.equal(f.sent.filter((item) => item.method === "sendMessage").length, 1);
});

test("start still replaces a Telegram panel that can no longer be edited", async () => {
  const f = fixture();
  await f.update("/start");
  f.failRetirement();
  await f.update("/start");
  await f.update("/settings");
  assert.equal(f.sent.filter((item) => item.method === "sendMessage").length, 2);
  const edits = f.sent.filter((item) => item.method === "editMessageText");
  assert.equal(edits.at(-1)!.payload.message_id, 102);
});

test("canonical panels never use non-editable ReplyKeyboardRemove markup", async () => {
  const f = fixture();
  f.enforceKeyboardEditRules();
  await f.update("/start");
  await f.update("/settings");
  const panels = f.sent.filter((item) => item.method === "sendMessage");
  assert.equal(panels.length, 1);
  assert.ok(panels[0]!.payload.reply_markup.inline_keyboard);
});

test("legacy keyboard cleanup uses one deleted helper and a separately editable canonical panel", async () => {
  const f = fixture();
  await f.update("/start");
  f.db.prepare("DELETE FROM ui_state WHERE key='keyboard-cleared:7:-100'").run();
  f.enforceKeyboardEditRules();
  await f.update("/start");
  await f.update("/settings");
  const sends = f.sent.filter((item) => item.method === "sendMessage");
  assert.equal(sends.length, 3);
  assert.deepEqual(sends[1]!.payload.reply_markup, { remove_keyboard: true });
  assert.ok(
    f.sent.some((item) => item.method === "deleteMessage" && item.payload.message_id === 102),
  );
  assert.ok(sends[2]!.payload.reply_markup.inline_keyboard);
  assert.equal(
    f.sent.filter((item) => item.method === "editMessageText").at(-1)!.payload.message_id,
    103,
  );
});

test("fresh Topic Settings invocation retires the old panel while callback navigation edits the new panel in place", async () => {
  const f = fixture();
  await f.update("⚙️ Topic Settings", 42);
  const first = f.scoped().panelIdentity(7, -100, 42, 1).messageId;
  assert.ok(first);
  let buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const appearance = buttons.find((button: any) => button.text === "💬 Response & Output");
  assert.ok(appearance);

  const sendsBeforeNavigation = f.sent.filter((entry) => entry.method === "sendMessage").length;
  await f.callback(appearance.callback_data, 42);
  assert.equal(f.sent.filter((entry) => entry.method === "sendMessage").length, sendsBeforeNavigation);
  assert.equal(f.sent.at(-1)!.method, "editMessageText");
  assert.equal(f.sent.at(-1)!.payload.message_id, first);

  await f.update("⚙️ Topic Settings", 42);
  const second = f.scoped().panelIdentity(7, -100, 42, 1).messageId;
  assert.ok(second);
  assert.notEqual(second, first);
  assert.ok(
    f.sent.some(
      (entry) => entry.method === "deleteMessage" && entry.payload.message_id === first,
    ),
  );
  buttons = f.sent.at(-1)!.payload.reply_markup?.inline_keyboard?.flat() ?? [];
  assert.equal(buttons.some((button: any) => button.text === "🏠 Home"), false);
  assert.ok(buttons.some((button: any) => button.text === "✖ Close"));
});

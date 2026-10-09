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
  let nextId = 100,
    missing = false,
    failTransport = false;
  let heldEdit: Promise<void> | undefined, releaseEdit: (() => void) | undefined;
  const deps = {
    sql,
    store,
    coreVersion: "v1.18.33-bot.13-pre.25",
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
        ((missing = false), (failTransport = false));
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
test("ALL unsolicited text is consumed without panel replies or execution", async () => {
  const f = fixture();
  await f.update("hello");
  await f.update("another message");
  assert.deepEqual(f.rpc, []);
  assert.equal(
    f.sent.filter((x) => ["sendMessage", "sendRichMessage", "editMessageText"].includes(x.method))
      .length,
    0,
  );
  assert.equal(f.sent.filter((x) => x.method === "deleteMessage").length, 2);
});
test("wizard prompt and answer edit the same panel and preserve explicit form admission", async () => {
  const f = fixture();
  await f.update("/settings");
  await f.update("/model_edit");
  await f.update("opencode/other");
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
  assert.deepEqual(f.rpc, ["global"]);
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

test("run readiness and active idle controls reuse the existing scoped panel", async () => {
  const f = fixture();
  await f.update("/settings", 42);
  const topic = f.store.topics()[0]!;
  await f.scoped().ready(topic);
  f.store.enqueue(-100, 42, "run", "question");
  f.store.startNext(-100, 42);
  await f.scoped().runKeyboard(topic, "run", true);
  f.store.finishRun(-100, 42, "run");
  await f.scoped().runKeyboard(topic, "run", false);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
  assert.ok(
    f.sent.filter((x) => x.method === "editMessageText").every((x) => x.payload.message_id === 101),
  );
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

test("History reopening another Topic edits its existing panel without another control message", async () => {
  const f = fixture();
  await f.update("/settings", 42);
  await f.update("/history");
  const button = f.button("OpenCode · 42")!;
  assert.ok(button);
  await f.callback(button.callback_data);
  await f.callback(button.callback_data);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 2);
  assert.equal(f.sent.at(-1)!.payload.message_id, 101);
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

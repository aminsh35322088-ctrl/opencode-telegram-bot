import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlPlane } from "../src/cloudflare/control-object.js";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { encryptCredential } from "../src/cloudflare/credentials.js";
import { signEnvelope } from "../src/cloudflare/protocol.js";

function fixture(t: { after: (f: () => void) => void }) {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (q: string, ...args: unknown[]) => db.prepare(q).all(...(args as never[])) as never,
  };
  const tx = <T>(f: () => T) => {
    db.exec("BEGIN");
    try {
      const v = f();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const env = {
    TELEGRAM_BOT_TOKEN: "synthetic",
    TELEGRAM_ALLOWED_USER_ID: "7",
    RAILWAY_API_TOKEN: "synthetic",
    RAILWAY_WORKSPACE_ID: "workspace",
    MAX_WORKERS: "10",
    WORKERS_PER_PROJECT: "5",
    MAX_RAILWAY_PROJECTS: "2",
    PROVISION_ON_TOPIC_CREATE: "true",
    PROVISIONING_ENABLED: "true",
    CREDENTIAL_MASTER_KEY: btoa("k".repeat(32)),
    WORKER_CORE_VERSION: "test",
    JOBS: { send: async () => {} },
  };
  const state = { storage: { sql, transactionSync: tx, setAlarm: async () => {} } };
  const plane = new ControlPlane(state as never, env as never);
  const store = new ControlStore(sql, tx);
  const sent: Array<{ method: string; payload: Record<string, any> }> = [];
  const rpc: Array<{ operation: string; payload: any }> = [];
  const rpcResults = new Map<string, unknown>();
  const secret = "n".repeat(64);
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const payload = JSON.parse(String(init?.body));
    if (String(input).includes("api.telegram.org")) {
      const method = String(input).split("/").at(-1)!;
      sent.push({ method, payload });
      return Response.json({
        ok: true,
        result:
          method === "createForumTopic" ? { message_thread_id: 84 } : { message_id: sent.length },
      });
    }
    rpc.push(payload);
    const result = rpcResults.has(payload.operation)
      ? rpcResults.get(payload.operation)
      : payload.operation === "model.inspect"
        ? { connected: true, available: true }
        : payload.operation === "session.messages"
          ? []
          : payload.operation === "models.list"
            ? { providers: [] }
            : null;
    const signed = await signEnvelope(
      {
        ...payload,
        nonce: crypto.randomUUID(),
        timestamp: Date.now(),
        payload: { ok: true, result },
      },
      secret,
    );
    return new Response(signed.body, { headers: { "x-node-signature": signed.signature } });
  };
  t.after(() => {
    globalThis.fetch = original;
    db.close();
  });
  const post = (path: string, body: unknown = {}) =>
    plane.fetch(
      new Request("https://internal" + path, { method: "POST", body: JSON.stringify(body) }),
    );
  let seq = 1000;
  const update = async (text: string, threadId?: number, actor = 7) => {
    await post("/telegram/webhook", {
      update_id: ++seq,
      message: {
        message_id: seq,
        chat: { id: -100 },
        from: { id: actor },
        ...(threadId ? { message_thread_id: threadId } : {}),
        text,
      },
    });
    await plane.alarm();
  };
  const callback = async (data: string, threadId?: number, actor = 7) => {
    await post("/telegram/webhook", {
      update_id: ++seq,
      callback_query: {
        id: String(seq),
        from: { id: actor },
        data,
        message: {
          message_id: (() => {
            const callback = [
              ...sql.exec<{ actor: number; chat: number; thread: number; generation: number }>(
                "SELECT actor,chat,thread,generation FROM ui_callbacks WHERE id=?",
                data.slice(3),
              ),
            ][0];
            if (!callback) return 90;
            const panel = [
              ...sql.exec<{ data: string }>(
                "SELECT data FROM ui_state WHERE key=?",
                `panel:${callback.actor}:${callback.chat}:${callback.thread}:${callback.generation}`,
              ),
            ][0];
            return panel ? JSON.parse(panel.data).messageId : 90;
          })(),
          chat: { id: -100 },
          ...(threadId ? { message_thread_id: threadId } : {}),
        },
      },
    });
    await plane.alarm();
  };
  const bound = async () => {
    await post("/admin/setup");
    await post("/admin/global", {
      configuration: { runtime: { model: "opencode/big-pickle" } },
      skills: [],
      actions: [],
      catalog: {},
      defaults: {},
      credentialReferences: [],
    });
    const job = store.reserveTopicAllocation("ui", -100, 42);
    store.configureJob(job.jobId, { endpoint: "https://canary.up.railway.app" });
    const credential = await encryptCredential(
      env.CREDENTIAL_MASTER_KEY,
      "node:" + job.workerId + ":1",
      secret,
    );
    store.ready(job.workerId, 1, credential);
    store.bindTopic(job.jobId, 42, "session");
    return job;
  };
  return { plane, store, sql, sent, rpc, rpcResults, update, callback, bound, post, state, env };
}

test("Start restores main navigation and publishes the existing Telegram command catalog without allocating", async (t) => {
  const f = fixture(t);
  await f.update("/start");
  const output = JSON.stringify(f.sent);
  assert.match(output, /⚡ <b>OpenCode Telegram<\/b>/);
  assert.match(output, /🕘 History/);
  assert.match(output, /⚙️ Main Settings/);
  assert.equal(f.sent.filter((x) => x.method === "sendMessage").length, 1);
  assert.ok(f.sent.some((x) => x.method === "pinChatMessage"));
  assert.ok(
    f.sent.some(
      (x) =>
        x.method === "setMyCommands" &&
        x.payload.commands.some((c: any) => c.command === "settings"),
    ),
  );
  assert.equal(f.store.workers().length, 0);
});

test("keyboard restores dedicated Topic controls and never sends the command to OpenCode", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/keyboard", 42);
  const output = JSON.stringify(f.sent);
  assert.match(output, /Delete Chat/);
  assert.match(output, /Topic Settings/);
  assert.match(output, /Compact/);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("unknown slash commands and stale reply keyboard controls cannot become model prompts", async (t) => {
  const f = fixture(t);
  await f.bound();
  for (const text of ["/unknown", "⚙️ Main Settings", "🕘 History"]) await f.update(text, 42);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
  assert.ok(f.sent.length >= 3);
});

test("settings preserves separate global and Topic navigation", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/settings");
  let output = JSON.stringify(f.sent);
  assert.match(output, /⚙️ <b>Settings<\/b>/);
  assert.match(output, /🧠 Model Center/);
  assert.match(output, /Extensions/);
  assert.match(output, /Actions/);
  assert.match(output, /GitHub/);
  assert.match(output, /Tailscale/);
  assert.match(output, /⋯ More/);
  f.sent.length = 0;
  await f.update("⚙️ Topic Settings", 42);
  output = JSON.stringify(f.sent);
  assert.match(output, /🧵 <b>Topic Settings<\/b>/);
  assert.match(output, /🧠 <b>Model Center<\/b>/);
  assert.match(output, /Context Health/);
  assert.match(output, /Agent/);
  assert.match(output, /Variant/);
  assert.match(output, /Response & Output/);
  assert.match(output, /Prompt Queue/);
  assert.doesNotMatch(output, /🧭 Session/);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("legacy Settings submenus keep More/Advanced and Topic Models navigation", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/settings");
  let buttons = f.sent.flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const more = buttons.find((b: any) => b.text === "⋯ More");
  assert.ok(more);
  await f.callback(more.callback_data);
  let output = JSON.stringify(f.sent);
  assert.match(output, /Topic Defaults/);
  assert.match(output, /Experimental/);
  assert.match(output, /Advanced/);
  buttons = f.sent.flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const advanced = buttons.find((b: any) => b.text === "🧰 Advanced");
  assert.ok(advanced);
  await f.callback(advanced.callback_data);
  output = JSON.stringify(f.sent);
  assert.match(output, /Custom Commands/);
  assert.match(output, /Persistent Memory/);
  assert.match(output, /Clear Conversation History/);
  assert.match(output, /Factory Reset/);

  f.sent.length = 0;
  await f.update("/settings", 42);
  buttons = f.sent.flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const models = buttons.find((b: any) => b.text === "🧠 Models");
  assert.ok(models);
  await f.callback(models.callback_data, 42);
  output = JSON.stringify(f.sent);
  assert.match(output, /Primary \/ Chat & Coding/);
  assert.match(output, /Image AI/);
  assert.match(output, /Voice → Text/);
  assert.equal(
    f.rpc.some((r) => r.operation === "execute"),
    false,
  );
});

test("delete requires a generation-scoped confirmation and rejects it after fencing", async (t) => {
  const f = fixture(t);
  const job = await f.bound();
  await f.update("🗑️ Delete Chat", 42);
  assert.equal(f.store.worker(job.workerId)?.generation, 1);
  const buttons = f.sent.flatMap((x) => x.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const confirm = buttons.find(
    (b: any) => /Delete/.test(b.text) && String(b.callback_data).startsWith("ui:"),
  );
  assert.ok(confirm, "confirmation button expected");
  f.store.fenceTopic(-100, 42);
  f.sent.length = 0;
  await f.callback(confirm.callback_data, 42);
  assert.equal(
    f.sent.some((x) => x.method === "deleteForumTopic"),
    false,
  );
  assert.equal(
    f.rpc.some((x) => x.operation === "retire"),
    false,
  );
});

test("callback from another actor or Topic cannot execute a bound confirmation", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/delete_topic", 42);
  const buttons = f.sent.flatMap((x) => x.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const confirm = buttons.find((b: any) => String(b.callback_data).startsWith("ui:"));
  assert.ok(confirm);
  await f.callback(confirm.callback_data, 43);
  await f.callback(confirm.callback_data, 42, 9);
  assert.equal(f.rpc.length, 0);
  assert.equal(f.store.topics()[0]?.state, "ACTIVE");
});

test("compact is durable Topic presentation state and does not duplicate global enable state", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("📦 Compact: OFF", 42);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
  const revision = f.store.global()!.revision;
  f.sent.length = 0;
  const restarted = new ControlPlane(f.state as never, f.env as never);
  await f.post("/telegram/webhook", {
    update_id: 2000,
    message: { chat: { id: -100 }, from: { id: 7 }, message_thread_id: 42, text: "/keyboard" },
  });
  await restarted.alarm();
  assert.equal(f.sent.filter((entry) => entry.payload.reply_markup?.keyboard).length, 1);
  const labels = f.sent.flatMap((entry) =>
    (entry.payload.reply_markup?.keyboard?.flat() ?? []).map((button: any) => String(button.text)),
  );
  assert.ok(labels.some((label) => /Compact: ON/.test(label)));
  const topicState = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='topic:-100:42:1'"),
  ][0];
  assert.equal(JSON.parse(topicState!.data).compact, true);
  assert.equal(f.store.global()!.revision, revision);
});

test("plain text in General explains the Topic requirement without execution or allocation", async (t) => {
  const f = fixture(t);
  await f.update("چطوری");
  assert.ok(f.sent.length);
  assert.equal(f.store.workers().length, 0);
  assert.equal(f.rpc.length, 0);
});

test("cancel clears the durable input form", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/rename", 42);
  await f.update("/cancel", 42);
  await f.update("normal prompt", 42);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 1);
  assert.equal(
    f.sent.some((x) => x.method === "editForumTopic"),
    false,
    "a user prompt alone must never become the Telegram topic title",
  );
});

test("rename answer remains a control after an acknowledgement rate limit", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/rename", 42);
  const before = globalThis.fetch;
  let failed = false;
  globalThis.fetch = async (input, init) => {
    const payload = JSON.parse(String(init?.body));
    if (
      !failed &&
      String(input).endsWith("/editMessageText") &&
      JSON.stringify(payload).includes("renamed")
    ) {
      failed = true;
      return Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 1 } },
        { status: 429 },
      );
    }
    return before(input, init);
  };
  await f.update("renamed title", 42);
  await f.plane.alarm();
  assert.equal(failed, true);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
  assert.equal(f.sent.filter((x) => x.method === "editForumTopic").length, 1);
});

test("legacy Abort command cannot cancel the current or next run", async (t) => {
  const f = fixture(t);
  await f.bound();
  f.store.enqueue(-100, 42, "run_a", "a");
  f.store.startNext(-100, 42);
  await f.update("/abort", 42);
  assert.equal(f.rpc.some((entry) => entry.operation === "stop"), false);
  assert.equal(f.store.activeRuns(-100, 42)[0]?.requestId, "run_a");
  f.store.failRun(-100, 42, "run_a", "done");
  f.store.enqueue(-100, 42, "run_b", "b");
  f.store.startNext(-100, 42);
  assert.equal(f.store.activeRuns(-100, 42)[0]?.requestId, "run_b");
  assert.equal(f.rpc.some((entry) => entry.operation === "stop"), false);
});

test("readiness keyboard retries Telegram 429 without duplicating a delivered notice", async (t) => {
  const f = fixture(t);
  await f.bound();
  const before = globalThis.fetch;
  let failed = false;
  globalThis.fetch = async (input, init) => {
    if (!failed && String(input).endsWith("/sendMessage")) {
      failed = true;
      return Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 1 } },
        { status: 429 },
      );
    }
    return before(input, init);
  };
  const ui = (f.plane as unknown as { ui: () => { ready: (topic: any) => Promise<void> } }).ui();
  await assert.rejects(ui.ready(f.store.topics()[0]));
  await ui.ready(f.store.topics()[0]);
  const afterSuccess = f.sent.length;
  await ui.ready(f.store.topics()[0]);
  assert.equal(f.sent.length, afterSuccess);
  assert.equal(f.sent.filter((x) => x.payload.reply_markup?.remove_keyboard).length, 0);
  assert.equal(f.sent.filter((x) => x.payload.reply_markup?.inline_keyboard).length, 0);
  assert.equal(f.sent.filter((x) => x.payload.reply_markup?.keyboard).length, 1);
});

test("questions render in their Topic and their answers never become prompts", async (t) => {
  const f = fixture(t);
  await f.bound();
  f.store.enqueue(-100, 42, "run_q", "ask");
  f.store.startNext(-100, 42);
  const ui = (
    f.plane as unknown as {
      ui: () => { interactions: (topic: any, actor: number) => Promise<void> };
    }
  ).ui();
  assert.equal(typeof ui.interactions, "function");
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("canary.up.railway.app")) return before(input, init);
    const envelope = JSON.parse(String(init?.body));
    const result =
      envelope.operation === "question.list"
        ? [
            {
              id: "q_owned",
              sessionID: "session",
              questions: [
                {
                  header: "Choose",
                  question: "Which option?",
                  options: [
                    { label: "Yes", description: "Proceed" },
                    { label: "No", description: "Cancel" },
                  ],
                },
              ],
            },
          ]
        : envelope.operation === "run"
          ? { accepted: true }
          : envelope.operation === "callback.status"
            ? { state: "ACCEPTED" }
            : null;
    f.rpc.push(envelope);
    const signed = await signEnvelope(
      {
        ...envelope,
        nonce: crypto.randomUUID(),
        timestamp: Date.now(),
        payload: { ok: true, result },
      },
      "n".repeat(64),
    );
    return new Response(signed.body, { headers: { "x-node-signature": signed.signature } });
  };
  const updatedUi = (f.plane as any).ui();
  await updatedUi.interactions(f.store.topics()[0], 7);
  assert.match(JSON.stringify(f.sent), /Which option/);
  const button = f.sent
    .flatMap((x) => x.payload.reply_markup?.inline_keyboard?.flat() ?? [])
    .find((b: any) => b.text === "Yes");
  assert.ok(button);
  await f.callback(button.callback_data, 42);
  const reply = f.rpc.find((x) => x.operation === "question.reply");
  assert.deepEqual(reply?.payload.answers, [["Yes"]]);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 1);
});

test("signed global mutations require exact trusted approval and preserve canonical revision", async (t) => {
  const f = fixture(t);
  const job = await f.bound();
  const mutation = {
    type: "skills.create",
    resource: "safe",
    config: { description: "Safe", body: "Do safe work" },
  };
  const call = async (operation: string, payload: unknown) => {
    const signed = await signEnvelope(
      {
        version: 1,
        nodeId: job.workerId,
        generation: 1,
        chatId: -100,
        threadId: 42,
        sessionId: "session",
        operation,
        payload,
        timestamp: Date.now(),
        nonce: crypto.randomUUID(),
      },
      "n".repeat(64),
    );
    return f.plane.fetch(
      new Request("https://internal/node-control", {
        method: "POST",
        headers: { "x-node-signature": signed.signature },
        body: signed.body,
      }),
    );
  };
  const preparedResponse = await call("mutation.prepare", { mutation });
  assert.equal(preparedResponse.status, 200);
  const prepared = (await preparedResponse.json()).payload;
  const revision = f.store.global()!.revision;
  assert.equal(
    (await call("mutation.commit", { mutation, approvalId: prepared.approvalId })).status,
    409,
  );
  assert.equal(f.store.global()!.revision, revision);
  const uiDecision = f.plane as unknown as {
    questionDecision: (
      topic: any,
      request: string,
      questions: unknown[],
      answers: string[][],
    ) => void;
  };
  assert.equal(typeof uiDecision.questionDecision, "function");
  uiDecision.questionDecision(f.store.topics()[0], "q_exact", [prepared.question], [["Approve"]]);
  assert.equal(
    (await call("mutation.commit", { mutation, approvalId: prepared.approvalId })).status,
    200,
  );
  assert.equal(f.store.global()!.revision, revision + 1);
  assert.equal(
    (await call("mutation.commit", { mutation, approvalId: prepared.approvalId })).status,
    200,
  );
  assert.equal(f.store.global()!.revision, revision + 1);
  const changed = { ...mutation, resource: "other" };
  assert.equal(
    (await call("mutation.commit", { mutation: changed, approvalId: prepared.approvalId })).status,
    409,
  );
});

test("double taps on New Chat reuse the pending allocation instead of creating a second Worker", async (t) => {
  const f = fixture(t);
  await f.update("/new");
  await f.update("/new");
  assert.equal(f.store.workers().length, 1);
  assert.equal(f.sent.filter((x) => x.method === "createForumTopic").length, 0);
});

test("a Topic fenced before final Telegram delivery cannot publish its old response", async (t) => {
  const f = fixture(t);
  await f.bound();
  f.store.enqueue(-100, 42, "late", "prompt");
  f.store.startNext(-100, 42);
  f.store.recordCallback(-100, 42, {
    runId: "late",
    streamNonce: "stream",
    sequence: 1,
    event: {
      type: "message.part.updated",
      properties: { part: { id: "text", type: "text", text: "old response" } },
    },
  });
  f.store.recordCallback(-100, 42, {
    runId: "late",
    streamNonce: "stream",
    sequence: 2,
    event: { type: "session.idle" },
  });
  f.store.fenceTopic(-100, 42);
  await f.plane.alarm();
  assert.equal(f.sent.length, 0);
});

test("session dashboard exposes owned todo/diff/subagent/file navigation", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/session", 42);
  const text = JSON.stringify(f.sent);
  for (const label of ["Tasks", "Changes", "Sub-agents", "Files"])
    assert.match(text, new RegExp(label));
  for (const command of ["/todos", "/diff", "/children", "/ls", "/open README.md"])
    await f.update(command, 42);
  for (const operation of [
    "session.todos",
    "session.diff",
    "session.children",
    "file.list",
    "file.read",
  ])
    assert.ok(
      f.rpc.some((r) => r.operation === operation),
      operation,
    );
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("legacy Session, Messages and Files reuse one Topic panel instead of sending message spam", async (t) => {
  const f = fixture(t);
  await f.bound();
  f.rpcResults.set("session.get", { id: "session", title: "Legacy Topic" });
  f.rpcResults.set("session.todos", [{ status: "pending", content: "Restore UI" }]);
  f.rpcResults.set("session.diff", [{ path: "src/a.ts", additions: 2, deletions: 1 }]);
  f.rpcResults.set("session.children", [{ id: "child", title: "Research" }]);
  f.rpcResults.set("session.messages", [
    {
      info: { id: "u1", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "first prompt" }],
    },
    {
      info: { id: "a1", role: "assistant", time: { created: 2000 } },
      parts: [{ type: "text", text: "answer" }],
    },
  ]);
  f.rpcResults.set("file.list", [
    { type: "directory", name: "src", path: "src" },
    { type: "file", name: "README.md", path: "README.md", size: 42 },
  ]);
  f.rpcResults.set("file.read", { encoding: "utf8", content: "# readme", size: 8 });

  await f.update("/session", 42);
  assert.match(JSON.stringify(f.sent), /OpenCode Session/);
  const initialSends = f.sent.filter((entry) => entry.method === "sendMessage").length;
  assert.equal(initialSends, 1);

  f.sent.length = 0;
  await f.update("/messages", 42);
  assert.equal(f.sent.filter((entry) => entry.method === "sendMessage").length, 0);
  assert.equal(f.sent.filter((entry) => entry.method === "editMessageText").length, 1);
  assert.match(JSON.stringify(f.sent), /first prompt/);
  let buttons = f.sent.flatMap(
    (entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? [],
  );
  const message = buttons.find((button: any) => String(button.text).includes("first prompt"));
  assert.ok(message);
  f.sent.length = 0;
  await f.callback(message.callback_data, 42);
  assert.equal(f.sent.filter((entry) => entry.method === "sendMessage").length, 0);
  assert.match(JSON.stringify(f.sent), /first prompt/);

  f.sent.length = 0;
  await f.update("/ls", 42);
  assert.equal(f.sent.filter((entry) => entry.method === "sendMessage").length, 0);
  assert.match(JSON.stringify(f.sent), /📁 src/);
  assert.match(JSON.stringify(f.sent), /📄 README.md/);
  buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const readme = buttons.find((button: any) => String(button.text).includes("README.md"));
  assert.ok(readme);
  f.sent.length = 0;
  await f.callback(readme.callback_data, 42);
  assert.equal(f.sent.filter((entry) => entry.method === "sendMessage").length, 0);
  assert.match(JSON.stringify(f.sent), /Workspace file|File|README.md/i);
  assert.match(JSON.stringify(f.sent), /Download/i);
  assert.equal(
    f.rpc.some((entry) => entry.operation === "execute"),
    false,
  );
});

test("Model Center uses the canonical legacy root instead of the simplified Cloudflare replacement", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/model", 42);
  const output = JSON.stringify(f.sent);
  assert.match(output, /🤖 <b>MODEL CENTER<\/b>/);
  assert.match(output, /🟢 <b>CURRENT MODEL<\/b>/);
  assert.match(output, /⭐ Favorites/);
  assert.match(output, /🕘 Recent models/);
  assert.match(output, /🔎 Search models/);
  assert.match(output, /🧩 Browse providers/);
  assert.doesNotMatch(output, /Primary \/ Chat & Coding/);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("model and agent selectors use Core catalogs without creating model runs", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/model", 42);
  await f.update("/agent", 42);
  await f.update("/variant", 42);
  assert.ok(f.rpc.some((r) => r.operation === "models.list"));
  assert.ok(f.rpc.some((r) => r.operation === "agents.list"));
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("internal destructive slash commands cannot bypass confirmation", async (t) => {
  const f = fixture(t);
  await f.bound();
  for (const [command, thread] of [
    ["/delete_confirm", 42],
    ["/factory_reset_final", undefined],
    ["/reset_history_confirm", undefined],
  ] as const)
    await f.update(command, thread);
  assert.equal(f.store.topics()[0]?.state, "ACTIVE");
  assert.equal(
    f.sent.some((x) => x.method === "deleteForumTopic"),
    false,
  );
});

test("raw output and footer preferences are applied to completed Topic responses", async (t) => {
  const f = fixture(t);
  await f.bound();
  const topic = f.store.topics()[0]!;
  f.sql.exec(
    "INSERT INTO ui_state VALUES(?,?)",
    "topic:-100:42:" + topic.generation,
    JSON.stringify({ messageFormatMode: "raw", showAssistantRunFooter: true }),
  );
  f.store.enqueueVerified(
    -100,
    42,
    "render_pref",
    "question",
    1,
    f.store.global()!.revision,
    "opencode/big-pickle",
  );
  f.store.startNext(-100, 42);
  f.store.failRun(-100, 42, "render_pref", "**سلام**");
  await f.plane.alarm();
  const messages = f.sent.filter((x) => x.method === "sendMessage").map((x) => x.payload.text);
  assert.ok(messages.some((text) => text.includes("**سلام**")));
  assert.ok(messages.some((text) => text.includes("opencode/big-pickle")));
  assert.equal(
    f.sent.some((x) => x.method === "sendRichMessage"),
    false,
  );
});

test("Telegram Topic deletion is idempotent after an acknowledged deletion is lost", async () => {
  const { CloudTelegram } = await import("../src/cloudflare/telegram.js");
  const telegram = new CloudTelegram("synthetic", async () =>
    Response.json(
      { ok: false, error_code: 400, description: "Bad Request: TOPIC_NOT_FOUND" },
      { status: 400 },
    ),
  );
  await telegram.call("deleteForumTopic", { chat_id: -100, message_thread_id: 42 });
  await assert.rejects(
    telegram.call("editForumTopic", { chat_id: -100, message_thread_id: 42, name: "name" }),
  );
});

test("Topic attachments are durably admitted and only inline file data reaches Core", async (t) => {
  const f = fixture(t);
  await f.bound();
  const outbound = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/getFile"))
      return Response.json({ ok: true, result: { file_path: "docs/a.txt", file_size: 3 } });
    if (url.includes("/file/bot")) return new Response("abc");
    return outbound(input, init);
  };
  await f.post("/telegram/webhook", {
    update_id: 3000,
    message: {
      message_id: 3000,
      chat: { id: -100 },
      from: { id: 7 },
      message_thread_id: 42,
      document: { file_id: "file-id", file_name: "a.txt", file_size: 3, mime_type: "text/plain" },
      caption: "Read this",
    },
  });
  await f.plane.alarm();
  await f.plane.alarm();
  const request = f.rpc.find((r) => r.operation === "run");
  assert.ok(request);
  assert.match(JSON.stringify(request.payload.parts), /data:text\/plain;base64,YWJj/);
  assert.equal(JSON.stringify(request).includes("synthetic"), false);
});

test("attachments cannot bypass an active UI input form into model execution", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/rename", 42);
  await f.post("/telegram/webhook", {
    update_id: 3100,
    message: {
      message_id: 3100,
      chat: { id: -100 },
      from: { id: 7 },
      message_thread_id: 42,
      document: { file_id: "id", file_size: 1 },
    },
  });
  await f.plane.alarm();
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("media model defaults are pinned for attachments without changing chat model or sharing execution", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.post("/admin/global", {
    configuration: { runtime: { model: "opencode/big-pickle" } },
    skills: [],
    actions: [],
    catalog: {},
    defaults: { voiceModel: "example/audio" },
    credentialReferences: [],
  });
  const outbound = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/getFile"))
      return Response.json({ ok: true, result: { file_path: "voice/a.ogg", file_size: 3 } });
    if (String(input).includes("/file/bot")) return new Response("ogg");
    return outbound(input, init);
  };
  await f.post("/telegram/webhook", {
    update_id: 3300,
    message: {
      message_id: 3300,
      chat: { id: -100 },
      from: { id: 7 },
      message_thread_id: 42,
      voice: { file_id: "voice-id", file_size: 3, mime_type: "audio/ogg" },
    },
  });
  await f.plane.alarm();
  assert.equal(f.store.runPin("telegram_3300")?.model, "example/audio");
  assert.equal((f.store.global()!.data.configuration as any).runtime.model, "opencode/big-pickle");
  assert.equal(f.store.workers().length, 1);
});

test("streaming toggle persists an actual transport mode rather than a boolean", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/appearance", 42);
  const buttons = f.sent.flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const button = buttons.find((b: any) => String(b.text).toLowerCase().includes("streaming"));
  assert.ok(button);
  await f.callback(button.callback_data, 42);
  const row = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='topic:-100:42:1'"),
  ][0];
  assert.equal(JSON.parse(row.data).responseStreamingMode, "off");
});

test("managed Topic ReplyKeyboard never exposes legacy Pause Resume or Abort controls", async (t) => {
  const f = fixture(t);
  await f.bound();
  f.store.enqueue(-100, 42, "keyboard_run", "prompt");
  f.store.startNext(-100, 42);
  await f.update("/keyboard", 42);
  const active = f.sent.filter((entry) => entry.payload.reply_markup?.keyboard);
  assert.ok(active.length > 0);
  assert.match(JSON.stringify(active), /Compact/);
  assert.match(JSON.stringify(active), /Delete Chat/);
  assert.match(JSON.stringify(active), /Topic Settings/);
  assert.doesNotMatch(JSON.stringify(active), /Pause|Resume|Abort/);
  f.store.failRun(-100, 42, "keyboard_run", "stopped");
  f.sent.length = 0;
  await f.update("/keyboard", 42);
  const idle = f.sent.filter((entry) => entry.payload.reply_markup?.keyboard);
  assert.ok(idle.length > 0);
  assert.doesNotMatch(JSON.stringify(idle), /Pause|Resume|Abort/);
});

test("Topic preferences store only overrides and never duplicate canonical global defaults", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.post("/admin/global", {
    configuration: { runtime: { model: "opencode/big-pickle" } },
    skills: [],
    actions: [],
    catalog: {},
    defaults: { memory: [{ content: "global memory" }], showThinkingContent: true },
    credentialReferences: [],
  });
  await f.update("/compact", 42);
  const row = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='topic:-100:42:1'"),
  ][0];
  const value = JSON.parse(row.data);
  assert.equal("memory" in value, false);
  assert.equal("showThinkingContent" in value, false);
  assert.equal(value.compact, true);
});

test("a sleeping Worker keeps a prompt pending until signed readiness succeeds", async (t) => {
  const f = fixture(t);
  const job = await f.bound();
  f.store.saveObservation(job.workerId, 1, {
    runtimeVersion: "1.18.33-bot.13-pre.24",
    revision: f.store.global()!.revision,
  });
  let ready = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("api.telegram.org")) return original(input, init);
    const request = JSON.parse(String(init?.body));
    if (request.operation !== "health") return original(input, init);
    const signed = await signEnvelope(
      {
        ...request,
        nonce: crypto.randomUUID(),
        timestamp: Date.now(),
        payload: { ok: true, result: { ready } },
      },
      "n".repeat(64),
    );
    return new Response(signed.body, { headers: { "x-node-signature": signed.signature } });
  };
  await f.update("wake prompt", 42);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
  assert.equal(
    f.rpc.some((r) => r.operation === "model.inspect"),
    false,
  );
  ready = true;
  await f.plane.alarm();
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 1);
});

test("Prompt Queue menu shows effective queue default and first toggle disables queue", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/queue", 42);
  const button = f.sent
    .flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? [])
    .find((b: any) => b.text === "📥 Prompt queue: ON");
  assert.ok(button);
  await f.callback(button.callback_data, 42);
  const row = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='topic:-100:42:1'"),
  ][0];
  assert.equal(JSON.parse(row.data).promptQueueEnabled, false);
  assert.equal(
    f.rpc.some((r) => r.operation === "execute"),
    false,
  );
});

test("canonical Topic defaults apply without being copied into Topic overrides", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.post("/admin/global", {
    configuration: { runtime: { model: "opencode/big-pickle" } },
    skills: [],
    actions: [],
    catalog: {},
    credentialReferences: [],
    defaults: {
      topicDefaults: {
        compactOutputMode: true,
        promptQueueEnabled: false,
        responseStreamingMode: "off",
      },
    },
  });
  await f.update("/appearance", 42);
  let buttons = f.sent.flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  assert.ok(buttons.some((b: any) => b.text === "📦 Compact output: ON"));
  assert.equal(
    buttons.some((b: any) => String(b.text).includes("Prompt queue")),
    false,
  );
  const streaming = buttons.find((b: any) => String(b.text).toLowerCase().includes("streaming"));
  assert.ok(streaming);
  await f.callback(streaming.callback_data, 42);
  f.sent.length = 0;
  await f.update("/queue", 42);
  buttons = f.sent.flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  assert.ok(buttons.some((b: any) => b.text === "📥 Prompt queue: OFF"));
  const row = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='topic:-100:42:1'"),
  ][0];
  assert.deepEqual(JSON.parse(row.data), { responseStreamingMode: "edit" });
});

test("cancelling guided task setup invalidates its old confirmation", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/task", 42);
  await f.update("every 5 minutes", 42);
  await f.update("Check project", 42);
  const buttons = f.sent.flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const confirm = buttons.find((b: any) => b.text === "✅ Save scheduled task");
  assert.ok(confirm);
  await f.update("/cancel", 42);
  await f.callback(confirm.callback_data, 42);
  assert.equal([...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task:%'")].length, 0);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("expired task-form answer cannot become an ordinary model prompt", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/task", 42);
  const key = "form:7:-100:42";
  const row = [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key)][0];
  f.sql.exec(
    "UPDATE ui_state SET data=? WHERE key=?",
    JSON.stringify({ ...JSON.parse(row.data), expires: 0 }),
    key,
  );
  await f.update("every 5 minutes", 42);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
  assert.match(JSON.stringify(f.sent), /expired/i);
});

test("authenticated UI smoke test can open and cancel task setup without execution", async (t) => {
  const f = fixture(t);
  await f.bound();
  const start = await f.post("/admin/ui", { chatId: -100, threadId: 42, command: "task" });
  assert.equal(start.status, 200);
  assert.equal(
    [...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'")].length,
    1,
  );
  const cancel = await f.post("/admin/ui", { chatId: -100, threadId: 42, command: "cancel" });
  assert.equal(cancel.status, 200);
  assert.equal(
    [...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'")].length,
    0,
  );
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("cancelled configuration wizard cannot commit its old confirmation", async (t) => {
  const f = fixture(t);
  await f.bound();
  const revision = f.store.global()!.revision;
  await f.update("/skills");
  const add = f.sent
    .flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? [])
    .find((b: any) => b.text === "＋ Add / Edit");
  assert.ok(add);
  await f.callback(add.callback_data);
  await f.update("project-check");
  await f.update("Use before changing project files.");
  await f.update("Inspect the project before changing files.");
  const confirm = f.sent
    .flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? [])
    .find((b: any) => b.text === "✅ Save configuration");
  assert.ok(confirm);
  await f.update("/cancel");
  await f.callback(confirm.callback_data);
  assert.equal(f.store.global()!.revision, revision);
  assert.deepEqual(f.store.global()!.data.skills, []);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("authenticated read-only UI checks render guided Skills and MCP menus without execution", async (t) => {
  const f = fixture(t);
  await f.bound();
  const now = Date.now;
  const fixedTime = now();
  Date.now = () => fixedTime;
  t.after(() => {
    Date.now = now;
  });
  for (const command of ["skills", "mcps"]) {
    const plane = command === "mcps" ? new ControlPlane(f.state as never, f.env as never) : f.plane;
    const result = await plane.fetch(
      new Request("https://internal/admin/ui", {
        method: "POST",
        body: JSON.stringify({ chatId: -100, command }),
      }),
    );
    assert.equal(result.status, 200);
  }
  const labels = f.sent
    .flatMap((s) => s.payload.reply_markup?.inline_keyboard?.flat() ?? [])
    .map((b: any) => b.text);
  assert.ok(labels.includes("＋ Remote MCP"));
  assert.ok(labels.includes("Advanced JSON"));
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("General menus edit the same pinned canonical panel without creating a second panel", async (t) => {
  const f = fixture(t);
  await f.update("/start");
  const main = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='legacy:main:-100'"),
  ][0];
  assert.ok(main);
  const mainMessageId = JSON.parse(main.data).messageId as number;
  f.sent.length = 0;
  await f.update("/settings");
  assert.equal(
    f.sent.some(
      (entry) => entry.method === "editMessageText" && entry.payload.message_id === mainMessageId,
    ),
    true,
  );
  assert.equal(f.sent.filter((entry) => entry.method === "sendMessage").length, 0);
  const after = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='legacy:main:-100'"),
  ][0];
  assert.equal(JSON.parse(after.data).messageId, mainMessageId);
});

test("Settings descendants use explicit Back parents and Home", async (t) => {
  const f = fixture(t);
  await f.update("/settings");
  let buttons = f.sent.flatMap(
    (entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? [],
  );
  const more = buttons.find((button: any) => button.text === "⋯ More");
  assert.ok(more);
  f.sent.length = 0;
  await f.callback(more.callback_data);
  buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  assert.deepEqual(
    buttons
      .filter((button: any) => ["← Back", "🏠 Home"].includes(button.text))
      .map((button: any) => button.text),
    ["← Back", "🏠 Home"],
  );
  const advanced = buttons.find((button: any) => button.text === "🧰 Advanced");
  assert.ok(advanced);
  f.sent.length = 0;
  await f.callback(advanced.callback_data);
  buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const back = buttons.find((button: any) => button.text === "← Back");
  assert.ok(back);
  f.sent.length = 0;
  await f.callback(back.callback_data);
  assert.match(JSON.stringify(f.sent), /Topic Defaults|Experimental|Advanced/);
});

test("Topic Settings child returns to Topic Settings with Back and Close only", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("⚙️ Topic Settings", 42);
  let buttons = f.sent.flatMap(
    (entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? [],
  );
  const appearance = buttons.find((button: any) => button.text === "💬 Response & Output");
  assert.ok(appearance);
  f.sent.length = 0;
  await f.callback(appearance.callback_data, 42);
  buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const navigation = buttons.filter((button: any) => ["← Back", "🏠 Home", "✖ Close"].includes(button.text));
  assert.deepEqual(
    navigation.map((button: any) => button.text),
    ["← Back", "✖ Close"],
  );
  f.sent.length = 0;
  await f.callback(navigation[0].callback_data, 42);
  assert.match(JSON.stringify(f.sent), /🧵 <b>Topic Settings<\/b>/);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("Session and Model Center children return to their exact parents", async (t) => {
  const f = fixture(t);
  await f.bound();

  await f.update("/session", 42);
  let buttons = f.sent.flatMap(
    (entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? [],
  );
  const messages = buttons.find((button: any) => button.text === "🕘 Messages");
  assert.ok(messages);
  f.sent.length = 0;
  await f.callback(messages.callback_data, 42);
  buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  let back = buttons.find((button: any) => button.text === "← Back");
  assert.ok(back);
  assert.ok(buttons.some((button: any) => button.text === "🏠 Home"));
  f.sent.length = 0;
  await f.callback(back.callback_data, 42);
  assert.match(JSON.stringify(f.sent), /🧭 OpenCode Session/);

  f.sent.length = 0;
  await f.update("/model", 42);
  buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const favorites = buttons.find((button: any) => String(button.text).startsWith("⭐ Favorites"));
  assert.ok(favorites);
  f.sent.length = 0;
  await f.callback(favorites.callback_data, 42);
  buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  back = buttons.find((button: any) => button.text === "← Back");
  assert.ok(back);
  assert.equal(buttons.some((button: any) => button.text === "🏠 Home"), false);
  assert.ok(buttons.some((button: any) => button.text === "✖ Close"));
  f.sent.length = 0;
  await f.callback(back.callback_data, 42);
  assert.match(JSON.stringify(f.sent), /MODEL CENTER/);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("wizard confirmation Cancel restores its origin after text form state is consumed", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/skills");
  const add = f.sent
    .flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? [])
    .find((button: any) => button.text === "＋ Add / Edit");
  assert.ok(add);
  await f.callback(add.callback_data);
  await f.update("project-check");
  await f.update("Use before changing project files.");
  await f.update("Inspect the project before changing files.");
  f.sent.length = 0;
  await f.update("/cancel");
  assert.match(JSON.stringify(f.sent), /🧠 Skills/);
  assert.doesNotMatch(JSON.stringify(f.sent), /Cancelled/);
});

test("task confirmation Cancel restores the task list after prompt form state is consumed", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/task", 42);
  await f.update("every 5 minutes", 42);
  await f.update("Check project", 42);
  f.sent.length = 0;
  await f.update("/cancel", 42);
  const output = JSON.stringify(f.sent);
  assert.match(output, /No scheduled tasks in this topic|Create scheduled task/);
  assert.doesNotMatch(output, /Cancelled/);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("File browser subdirectories have explicit parent Back plus Home", async (t) => {
  const f = fixture(t);
  await f.bound();
  f.rpcResults.set("file.list", [{ type: "directory", name: "src", path: "src" }]);
  await f.update("/ls", 42);
  let buttons = f.sent.flatMap(
    (entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? [],
  );
  const src = buttons.find((button: any) => String(button.text).includes("src"));
  assert.ok(src);
  f.sent.length = 0;
  await f.callback(src.callback_data, 42);
  buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const back = buttons.find((button: any) => button.text === "← Back");
  assert.ok(back);
  assert.ok(buttons.some((button: any) => button.text === "🏠 Home"));
  f.sent.length = 0;
  await f.callback(back.callback_data, 42);
  const lists = f.rpc.filter((entry) => entry.operation === "file.list");
  assert.equal(lists.at(-1)?.payload.path, ".");
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});


test("active Cloudflare runs emit a Topic-scoped typing action without making typing a run dependency", async (t) => {
  const f = fixture(t);
  await f.bound();
  f.store.enqueue(-100, 42, "typing_probe", "probe");
  f.store.startNext(-100, 42);
  await f.plane.alarm();
  const typing = f.sent.find((entry) => entry.method === "sendChatAction");
  assert.ok(typing);
  assert.deepEqual(typing.payload, { chat_id: -100, message_thread_id: 42, action: "typing" });
  const row = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='typing:typing_probe'"),
  ][0];
  assert.ok(row, "typing refresh state must be persisted for the next Durable Object alarm");
});

test("ordinary user text is never deleted just because it is not a ReplyKeyboard control", async (t) => {
  const f = fixture(t);
  await f.bound();

  f.sent.length = 0;
  const before = [...f.sql.exec("SELECT request FROM runs")].length;
  await f.update("Please inspect the project and fix the bug", 42);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, before + 1);
  assert.equal(
    f.sent.filter((entry) => entry.method === "deleteMessage").length,
    0,
    "an ordinary AI Topic prompt must remain visible",
  );

  f.sent.length = 0;
  const afterTopicPrompt = [...f.sql.exec("SELECT request FROM runs")].length;
  await f.update("This is ordinary text in General");
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, afterTopicPrompt);
  assert.equal(
    f.sent.filter((entry) => entry.method === "deleteMessage").length,
    0,
    "ordinary General text may be blocked from execution but must not be deleted",
  );
});

test("only exact rendered Topic controls are consumed; an emoji-prefixed user prompt still reaches the model", async (t) => {
  const f = fixture(t);
  await f.bound();
  await f.update("/keyboard", 42);
  const modelButton = f.sent
    .flatMap((entry) => entry.payload.reply_markup?.keyboard?.flat() ?? [])
    .find((button: any) => String(button.text).startsWith("🧠 "));
  assert.ok(modelButton);
  const before = [...f.sql.exec("SELECT request FROM runs")].length;
  await f.update(modelButton.text, 42);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, before);
  assert.match(JSON.stringify(f.sent), /MODEL CENTER/);
  await f.update("🧠 Explain this architecture", 42);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, before + 1);
});

test("Factory Reset preserves configuration evidence when Railway reconciliation is ambiguous", async (t) => {
  const f = fixture(t);
  await f.post("/admin/setup");
  await f.post("/admin/global", {
    configuration: { runtime: { model: "keep/provider-model" }, marker: "preserve-me" },
    skills: [],
    actions: [],
    catalog: {},
    defaults: {},
    credentialReferences: [],
  });
  (f.plane as unknown as { driver: () => unknown }).driver = () => ({
    reconcileManagedResources: async () => {
      throw new Error("cleanup_reconciliation_required");
    },
  });
  const latestButton = (text: string) => {
    const buttons = f.sent.flatMap((entry) => entry.payload.reply_markup?.inline_keyboard?.flat() ?? []);
    const button = [...buttons].reverse().find((candidate: any) => candidate.text === text);
    assert.ok(button, `missing button ${text}`);
    return button as any;
  };
  await f.update("/settings");
  await f.callback(latestButton("⋯ More").callback_data);
  await f.callback(latestButton("🧰 Advanced").callback_data);
  await f.callback(latestButton("☢️ Factory Reset").callback_data);
  await f.callback(latestButton("🗑️ Factory Reset").callback_data);
  await f.callback(latestButton("🗑️ Final Factory Reset").callback_data);
  const global = f.store.global()!;
  assert.equal((global.data.configuration as any).marker, "preserve-me");
  assert.match(JSON.stringify(f.sent), /cleanup_reconciliation_required/);
});

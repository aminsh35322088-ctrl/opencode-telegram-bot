import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CloudRunUi } from "../src/cloudflare/run-ui.js";
import { CloudTelegram } from "../src/cloudflare/telegram.js";
function fixture(respond?: (method: string) => Response | Promise<Response>) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ui_state(key TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE runs(request TEXT PRIMARY KEY,chat INTEGER,thread INTEGER,state TEXT);
    CREATE TABLE topics(chat INTEGER,thread INTEGER,data TEXT);
    CREATE TABLE run_pins(request TEXT PRIMARY KEY,generation INTEGER);
  `);
  const topic = {
    chatId: 1,
    threadId: 42,
    generation: 1,
    workerId: "node",
    sessionId: "session",
    state: "ACTIVE",
  };
  db.prepare("INSERT INTO topics VALUES(?,?,?)").run(1, 42, JSON.stringify(topic));
  for (const run of ["run", "ambiguous"]) {
    db.prepare("INSERT INTO runs VALUES(?,?,?,?)").run(run, 1, 42, "ACTIVE");
    db.prepare("INSERT INTO run_pins VALUES(?,?)").run(run, 1);
  }
  const sql = {
    exec: (q: string, ...v: unknown[]) => db.prepare(q).all(...(v as never[])) as never,
  };
  let clock = Date.now();
  const sent: Array<{ method: string; body: any }> = [];
  const telegram = new CloudTelegram("synthetic", async (input, init) => {
    sent.push({ method: String(input).split("/").at(-1)!, body: JSON.parse(String(init?.body)) });
    return respond
      ? respond(sent.at(-1)!.method)
      : Response.json({ ok: true, result: { message_id: 9 } });
  });
  return {
    db,
    topic,
    sql,
    sent,
    now: () => clock,
    advance: () => {
      clock += 2000;
    },
    ui: new CloudRunUi(sql, telegram, () => clock),
  };
}
test("run controls stream bounded text, show governed tools and retain receipt after restart", async () => {
  const f = fixture();
  const topic = {
    chatId: 1,
    threadId: 42,
    generation: 1,
    workerId: "node",
    sessionId: "session",
    state: "ACTIVE",
  } as const;
  f.ui.capture("run", {
    type: "message.part.updated",
    properties: {
      part: {
        id: "tool",
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { secret: "not-for-ui" } },
      },
    },
  });
  await f.ui.progress(topic, "run", "سلام", {});
  assert.equal(f.sent[0]?.method, "sendMessage");
  assert.match(f.sent[0]?.body.text, /bash/);
  assert.equal(JSON.stringify(f.sent).includes("not-for-ui"), false);
  const restarted = new CloudRunUi(
    f.sql,
    new CloudTelegram("synthetic", async (input, init) => {
      f.sent.push({
        method: String(input).split("/").at(-1)!,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ ok: true, result: true });
    }),
  );
  await restarted.finish(topic, "run", "Final");
  assert.equal(f.sent.at(-1)?.method, "editMessageText");
  assert.equal(f.sent.at(-1)?.body.message_id, 9);
});
test("compatibility preview hides compact tools and never exposes reasoning", async () => {
  const f = fixture();
  const topic = {
    chatId: 1,
    threadId: 42,
    generation: 1,
    workerId: "node",
    sessionId: "session",
    state: "ACTIVE",
  } as const;
  f.ui.capture("run", {
    type: "message.part.updated",
    properties: { part: { id: "reason", type: "reasoning", text: "internal thought" } },
  });
  await f.ui.progress(topic, "run", "answer", { compact: true, showThinkingContent: false });
  assert.equal(f.sent[0]?.body.text, "answer");
  f.advance();
  await f.ui.progress(topic, "run", "answer2", { showThinkingContent: true });
  assert.doesNotMatch(f.sent.at(-1)?.body.text ?? "", /internal thought/);
});

test("an ambiguous preview send cannot be followed by a duplicate final send", async () => {
  const f = fixture();
  let calls = 0;
  const ui = new CloudRunUi(
    f.sql,
    new CloudTelegram("synthetic", async () => {
      calls++;
      throw new Error("network");
    }),
  );
  const topic = {
    chatId: 1,
    threadId: 42,
    generation: 1,
    workerId: "node",
    sessionId: "session",
    state: "ACTIVE",
  } as const;
  await assert.rejects(ui.progress(topic, "ambiguous", "preview", {}));
  await assert.rejects(ui.finish(topic, "ambiguous", "final"), /telegram_ambiguous/);
  assert.equal(calls, 1);
});

test("draft streaming retains identity across restart and persists final once", async () => {
  const f = fixture();
  await f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" });
  assert.equal(f.sent[0]?.method, "sendMessageDraft");
  const draft = f.sent[0]!.body.draft_id;
  assert.ok(Number.isSafeInteger(draft) && draft > 0);
  assert.equal(f.sent[0]!.body.can_stop, undefined);
  f.advance();
  const ui = new CloudRunUi(
    f.sql,
    new CloudTelegram("synthetic", async (input, init) => {
      f.sent.push({
        method: String(input).split("/").at(-1)!,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ ok: true, result: { message_id: 11 } });
    }),
    f.now,
  );
  await ui.progress(f.topic, "run", "next", { responseStreamingMode: "draft" });
  assert.equal(f.sent[1]!.body.draft_id, draft);
  assert.equal(await ui.finish(f.topic, "run", "final"), true);
  assert.equal(f.sent[2]?.method, "sendMessage");
  assert.equal(await ui.finish(f.topic, "run", "final"), true);
  assert.equal(f.sent.length, 3);
});

test("unsupported draft transport switches persistently to editing", async () => {
  const f = fixture((method) =>
    method === "sendMessageDraft"
      ? Response.json(
          { ok: false, error_code: 400, description: "Bad Request: drafts are not supported" },
          { status: 400 },
        )
      : Response.json({ ok: true, result: { message_id: 9 } }),
  );
  await f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" });
  assert.deepEqual(
    f.sent.map((x) => x.method),
    ["sendMessageDraft", "sendMessage"],
  );
  f.advance();
  await f.ui.progress(f.topic, "run", "next", { responseStreamingMode: "draft" });
  assert.equal(f.sent.at(-1)?.method, "editMessageText");
});

test("ambiguous draft transport retries same identity without edit fallback", async () => {
  let attempt = 0;
  const f = fixture(() => {
    if (++attempt === 1) throw new Error("network");
    return Response.json({ ok: true, result: true });
  });
  await assert.rejects(
    f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" }),
  );
  f.advance();
  await f.ui.progress(f.topic, "run", "next", { responseStreamingMode: "draft" });
  assert.deepEqual(
    f.sent.map((x) => x.method),
    ["sendMessageDraft", "sendMessageDraft"],
  );
  assert.equal(f.sent[0]!.body.draft_id, f.sent[1]!.body.draft_id);
});

test("draft previews refresh before their ephemeral lifetime expires", async () => {
  const f = fixture();
  await f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" });
  for (let i = 0; i < 11; i++) f.advance();
  await f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0]!.body.draft_id, f.sent[1]!.body.draft_id);
});

test("cancelled and generation-fenced runs cannot publish preview or final", async () => {
  const f = fixture();
  f.db.prepare("UPDATE runs SET state='CANCELLED' WHERE request='run'").run();
  await f.ui.progress(f.topic, "run", "late", { responseStreamingMode: "draft" });
  await assert.rejects(f.ui.finish(f.topic, "run", "late"));
  f.db.prepare("UPDATE runs SET state='ACTIVE' WHERE request='run'").run();
  f.db.prepare("UPDATE run_pins SET generation=2 WHERE request='run'").run();
  await f.ui.progress(f.topic, "run", "late", {});
  await assert.rejects(f.ui.finish(f.topic, "run", "late"));
  assert.equal(f.sent.length, 0);
});

test("tool cards show trusted titles and frozen timing without provider metadata", async () => {
  const f = fixture();
  f.ui.capture("run", {
    type: "message.part.updated",
    properties: {
      part: {
        id: "tool",
        type: "tool",
        tool: "bash",
        state: {
          status: "running",
          title: "SECRET-title",
          input: "SECRET-input",
          time: { start: 1 },
        },
      },
    },
  });
  for (let i = 0; i < 12; i++) f.advance();
  await f.ui.progress(f.topic, "run", "answer", {});
  assert.match(f.sent[0]!.body.text, /bash/);
  assert.match(f.sent[0]!.body.text, /🕒 20s/);
  f.ui.capture("run", {
    type: "message.part.updated",
    properties: {
      part: {
        id: "tool",
        type: "tool",
        tool: "bash",
        state: { status: "completed", output: "SECRET-output" },
      },
    },
  });
  for (let i = 0; i < 15; i++) f.advance();
  await f.ui.progress(f.topic, "run", "answer2", {});
  assert.match(f.sent.at(-1)!.body.text, /✓.*bash.*completed.*🕒 24s/);
  assert.equal(
    JSON.stringify([...f.db.prepare("SELECT data FROM ui_state").all()]).includes("SECRET"),
    false,
  );
});

test("an ambiguous draft final cannot resume streaming or send a duplicate final", async () => {
  const f = fixture((method) => {
    if (method === "sendMessage") throw new Error("network");
    return Response.json({ ok: true, result: true });
  });
  await f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" });
  await assert.rejects(f.ui.finish(f.topic, "run", "final"));
  f.advance();
  await f.ui.progress(f.topic, "run", "late", { responseStreamingMode: "draft" });
  await assert.rejects(f.ui.finish(f.topic, "run", "final"), /telegram_ambiguous/);
  assert.equal(f.sent.length, 2);
});

test("group chats use edit compatibility without attempting private-chat drafts", async () => {
  const f = fixture();
  const topic = { ...f.topic, chatId: -100 };
  f.db.prepare("UPDATE topics SET chat=?,data=?").run(topic.chatId, JSON.stringify(topic));
  f.db.prepare("UPDATE runs SET chat=?").run(topic.chatId);
  await f.ui.progress(topic, "run", "partial", { responseStreamingMode: "draft" });
  assert.equal(f.sent[0]?.method, "sendMessage");
});

test("tool names and statuses cannot carry arbitrary provider text", async () => {
  const f = fixture();
  f.ui.capture("run", {
    type: "message.part.updated",
    properties: {
      part: {
        id: "unknown",
        type: "tool",
        tool: "SECRET-tool-name",
        state: { status: "running" },
      },
    },
  });
  f.ui.capture("run", {
    type: "message.part.updated",
    properties: {
      part: {
        id: "status",
        type: "tool",
        tool: "bash",
        state: { status: "SECRET-status" },
      },
    },
  });
  await f.ui.progress(f.topic, "run", "answer", {});
  assert.equal(JSON.stringify(f.sent).includes("SECRET"), false);
  assert.equal(
    JSON.stringify(f.db.prepare("SELECT data FROM ui_state").all()).includes("SECRET"),
    false,
  );
});

test("tool completion cannot be regressed by replayed running events", async () => {
  const f = fixture();
  const event = (status: string) => ({
    type: "message.part.updated",
    properties: {
      part: {
        id: "tool",
        type: "tool",
        tool: "bash",
        state: { status },
      },
    },
  });
  f.ui.capture("run", event("running"));
  for (let i = 0; i < 12; i++) f.advance();
  f.ui.capture("run", event("completed"));
  f.advance();
  f.ui.capture("run", event("running"));
  await f.ui.progress(f.topic, "run", "answer", {});
  assert.match(f.sent[0]!.body.text, /completed.*🕒 24s/);
});

test("draft rate limits honor retry_after and do not fall back to edits", async () => {
  let attempts = 0;
  const f = fixture(() =>
    ++attempts === 1
      ? Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: 10 } },
          { status: 429 },
        )
      : Response.json({ ok: true, result: true }),
  );
  await assert.rejects(
    f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" }),
  );
  f.advance();
  await f.ui.progress(f.topic, "run", "next", { responseStreamingMode: "draft" });
  assert.equal(f.sent.length, 1);
  for (let i = 0; i < 5; i++) f.advance();
  await f.ui.progress(f.topic, "run", "next", { responseStreamingMode: "draft" });
  assert.deepEqual(
    f.sent.map((x) => x.method),
    ["sendMessageDraft", "sendMessageDraft"],
  );
});

test("interrupted persisted draft send can resume using its original identity", async () => {
  const f = fixture();
  f.db.prepare("INSERT INTO ui_state VALUES(?,?)").run(
    "run-ui:run",
    JSON.stringify({
      thoughts: {},
      tools: {},
      mode: "draft",
      draft: 123,
      delivery: "DRAFT_SENDING",
    }),
  );
  await f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" });
  assert.equal(f.sent[0]?.method, "sendMessageDraft");
  assert.equal(f.sent[0]?.body.draft_id, 123);
});

test("host-owned failed run responses may finalize a draft", async () => {
  const f = fixture();
  await f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" });
  f.db.prepare("UPDATE runs SET state='FAILED' WHERE request='run'").run();
  assert.equal(await f.ui.finish(f.topic, "run", "safe failure"), true);
  assert.equal(f.sent.at(-1)?.method, "sendMessage");
});

test("legacy unpinned responses without preview retain normal final renderer", async () => {
  const f = fixture();
  f.db.prepare("DELETE FROM run_pins WHERE request='run'").run();
  f.db.prepare("UPDATE runs SET state='COMPLETED' WHERE request='run'").run();
  assert.equal(await f.ui.finish(f.topic, "run", "final"), false);
  assert.equal(f.sent.length, 0);
});

test("a late draft acknowledgement cannot overwrite a persisted final receipt", async () => {
  let acknowledge!: () => void;
  const pending = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const f = fixture(async (method) => {
    if (method === "sendMessageDraft") await pending;
    return Response.json({ ok: true, result: { message_id: 9 } });
  });
  const progress = f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" });
  await f.ui.finish(f.topic, "run", "final");
  acknowledge();
  await progress;
  f.advance();
  await f.ui.progress(f.topic, "run", "late", { responseStreamingMode: "draft" });
  await f.ui.finish(f.topic, "run", "final");
  assert.deepEqual(
    f.sent.map((x) => x.method),
    ["sendMessageDraft", "sendMessage"],
  );
});

test("tool activity accepted during an awaited draft delivery remains durable", async () => {
  let acknowledge!: () => void;
  const pending = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const f = fixture(async () => {
    await pending;
    return Response.json({ ok: true, result: true });
  });
  const progress = f.ui.progress(f.topic, "run", "partial", { responseStreamingMode: "draft" });
  f.ui.capture("run", {
    type: "message.part.updated",
    properties: {
      part: {
        id: "tool",
        type: "tool",
        tool: "read",
        state: { status: "running" },
      },
    },
  });
  acknowledge();
  await progress;
  const row = f.db.prepare("SELECT data FROM ui_state WHERE key='run-ui:run'").get()!;
  assert.equal(JSON.parse(String(row.data)).tools.tool.name, "read");
});

test("throttled text exposes its next preview deadline rather than waiting for a status poll", async () => {
  const f = fixture();
  await f.ui.progress(f.topic as never, "run", "first", {});
  const due = await f.ui.progress(f.topic as never, "run", "second", {});
  assert.equal(due, f.now() + 1500);
  assert.equal(f.sent.length, 1);
  f.advance();
  await f.ui.progress(f.topic as never, "run", "second", {});
  assert.equal(f.sent.length, 2);
});

test("stream previews use canonical entities without leaking completed Markdown", async () => {
  const f = fixture();
  await f.ui.progress(f.topic, "run", "**نسخه‌ی OpenCode** `foo_bar` 👨‍💻", {
    responseStreamingMode: "draft",
  });
  assert.equal(f.sent[0]?.body.text, "نسخه‌ی OpenCode foo_bar 👨‍💻");
  assert.ok(f.sent[0]?.body.entities?.some((e: { type: string }) => e.type === "bold"));
  f.advance();
  await f.ui.progress(f.topic, "run", "**نسخه‌ی OpenCode** `foo_bar` 👨‍💻 ✅", {
    responseStreamingMode: "draft",
  });
  assert.equal(f.sent.at(-1)?.body.text, "نسخه‌ی OpenCode foo_bar 👨‍💻 ✅");
});

test("unrelated draft rejection never sends a compatibility message", async () => {
  const f = fixture(() =>
    Response.json(
      { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
      { status: 400 },
    ),
  );
  await assert.rejects(f.ui.progress(f.topic, "run", "hello", { responseStreamingMode: "draft" }));
  assert.deepEqual(
    f.sent.map((x) => x.method),
    ["sendMessageDraft"],
  );
});

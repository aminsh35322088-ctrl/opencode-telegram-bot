import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CloudRunUi } from "../src/cloudflare/run-ui.js";
import { CloudTelegram } from "../src/cloudflare/telegram.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ui_state(key TEXT PRIMARY KEY,data TEXT)");
  const sql = {
    exec: (q: string, ...v: unknown[]) => db.prepare(q).all(...(v as never[])) as never,
  };
  let clock = Date.now();
  const sent: Array<{ method: string; body: any }> = [];
  const telegram = new CloudTelegram("synthetic", async (input, init) => {
    sent.push({ method: String(input).split("/").at(-1)!, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: { message_id: 9 } });
  });
  return {
    db,
    sql,
    sent,
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
test("compact hides tool/thinking preview; thought visibility is explicit", async () => {
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
  assert.match(f.sent.at(-1)?.body.text, /internal thought/);
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

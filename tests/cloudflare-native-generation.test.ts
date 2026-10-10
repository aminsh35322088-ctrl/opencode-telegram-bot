import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "../src/cloudflare/control-store.js";
import { CloudTelegram } from "../src/cloudflare/telegram.js";
import { TelegramRunPresentationController } from "../src/cloudflare/run-presentation.js";

function fixture(respond?: (method: string, body: any) => Promise<Response> | Response) {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (q: string, ...v: unknown[]) => db.prepare(q).all(...(v as never[])) as never,
  };
  const store = new ControlStore(sql, (f) => f());
  const topic = {
    chatId: 7,
    threadId: 42,
    generation: 1,
    workerId: "worker",
    sessionId: "session",
    state: "ACTIVE",
  };
  sql.exec("INSERT INTO topics VALUES(?,?,?,?)", 7, 42, "worker", JSON.stringify(topic));
  store.enqueue(7, 42, "run", "prompt");
  store.pinRun("run", 1, 1, "provider/model");
  store.startNext(7, 42);
  let clock = 100_000;
  const sent: Array<{ method: string; body: any }> = [];
  const telegram = new CloudTelegram("synthetic", async (input, init) => {
    const method = String(input).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body));
    sent.push({ method, body });
    return respond
      ? respond(method, body)
      : Response.json({
          ok: true,
          result: method === "getChat" ? { id: 7, type: "private" } : true,
        });
  });
  const controller = () => new TelegramRunPresentationController(sql, telegram, () => clock);
  return {
    db,
    sql,
    store,
    topic,
    sent,
    controller,
    ui: controller(),
    advance: (ms = 2000) => {
      clock += ms;
    },
  };
}
const part = (id: string, type: string, extra = {}) => ({
  type: "message.part.updated",
  properties: { part: { id, type, ...extra } },
});
const drafts = (f: ReturnType<typeof fixture>) =>
  f.sent.filter((s) => s.method === "sendRichMessageDraft");

test("admitted private Topic starts one native thinking draft before any text", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  const first = drafts(f)[0]!.body;
  assert.equal(first.chat_id, 7);
  assert.equal(first.message_thread_id, 42);
  assert.ok(Number.isSafeInteger(first.draft_id) && first.draft_id > 0);
  assert.equal(first.can_stop, true);
  assert.equal(first.keep_on_stop, false);
  assert.equal(first.rich_message.blocks.at(-1).type, "thinking");
  f.advance(11000);
  await f.controller().update(f.topic, "run", "");
  assert.equal(drafts(f)[1]!.body.draft_id, first.draft_id);
});
test("thinking and every execution activity keep Stop without accumulating tool quotations", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  f.ui.capture(
    f.topic,
    "run",
    part("reason", "reasoning", { text: "SECRET CHAIN OF THOUGHT", time: { start: 1 } }),
  );
  for (const tool of ["read", "grep", "bash", "custom", "mcp", "lsp", "task", "webfetch"]) {
    f.ui.capture(
      f.topic,
      "run",
      part(tool, "tool", {
        tool,
        state: { status: "running", input: { secret: "PRIVATE INPUT" } },
      }),
    );
    f.advance();
    await f.ui.update(f.topic, "run", "");
    assert.equal(drafts(f).at(-1)!.body.can_stop, true);
    f.ui.capture(f.topic, "run", part(tool, "tool", { tool, state: { status: "completed" } }));
  }
  f.ui.capture(
    f.topic,
    "run",
    part("reason", "reasoning", { text: "SECRET CHAIN OF THOUGHT", time: { start: 1, end: 2 } }),
  );
  f.advance();
  await f.ui.update(f.topic, "run", "سلام **answer**");
  const blocks = drafts(f).at(-1)!.body.rich_message.blocks;
  assert.equal(blocks.filter((b: any) => b.type === "expandable_blockquote").length, 1);
  assert.equal(blocks.at(-1).type, "thinking");
  assert.equal(JSON.stringify(f.sent).includes("SECRET CHAIN"), false);
  assert.equal(
    JSON.stringify([...f.sql.exec("SELECT data FROM telegram_run_presentations")]).includes(
      "SECRET CHAIN",
    ),
    false,
  );
  assert.equal(JSON.stringify(f.sent).includes("PRIVATE INPUT"), false);
});
for (const activity of ["thinking", "read", "bash", "custom", "task", "streaming", "finalizing"]) {
  test(`native Stop during ${activity} fences exact run and late output`, async () => {
    const f = fixture();
    await f.ui.start(f.topic, "run");
    if (activity === "finalizing") f.ui.finalizing(f.topic, "run");
    else if (activity === "streaming") {
      f.advance();
      await f.ui.update(f.topic, "run", "partial");
    } else if (activity !== "thinking")
      f.ui.capture(
        f.topic,
        "run",
        part("tool", "tool", { tool: activity, state: { status: "running" } }),
      );
    const draftId = drafts(f)[0]!.body.draft_id;
    const stop = { chat: { id: 7, type: "private" }, message_thread_id: 42, draft_id: draftId };
    assert.equal(f.ui.acceptStop(stop)?.runId, "run");
    assert.equal(f.ui.acceptStop(stop), undefined);
    const count = f.sent.length;
    f.ui.capture(
      f.topic,
      "run",
      part("late", "tool", { tool: "read", state: { status: "running" } }),
    );
    f.advance();
    await f.ui.update(f.topic, "run", "late provider answer");
    assert.equal(f.sent.length, count);
    assert.equal(f.ui.canDeliver(f.topic, "run"), false);
    f.ui.cancelled("run");
    assert.equal(f.ui.binding("run")?.state, "CANCELLED");
  });
}
test("Native Stop requires the exact chat thread draft session worker and generation owner", async () => {
  const cases: Array<{ name: string; mutateStop?: (stop: any) => any; mutateTopic?: (topic: any) => any }> = [
    { name: "wrong chat", mutateStop: (stop) => ({ ...stop, chat: { id: 8, type: "private" } }) },
    { name: "wrong thread", mutateStop: (stop) => ({ ...stop, message_thread_id: 43 }) },
    { name: "wrong draft", mutateStop: (stop) => ({ ...stop, draft_id: stop.draft_id + 1 }) },
    { name: "replacement session", mutateTopic: (topic) => ({ ...topic, sessionId: "replacement-session" }) },
    { name: "replacement worker", mutateTopic: (topic) => ({ ...topic, workerId: "replacement-worker" }) },
    { name: "replacement generation", mutateTopic: (topic) => ({ ...topic, generation: 2 }) },
  ];
  for (const entry of cases) {
    const f = fixture();
    await f.ui.start(f.topic, "run");
    const original = {
      chat: { id: 7, type: "private" },
      message_thread_id: 42,
      draft_id: drafts(f)[0]!.body.draft_id,
    };
    if (entry.mutateTopic)
      f.sql.exec("UPDATE topics SET data=? WHERE chat=7 AND thread=42", JSON.stringify(entry.mutateTopic(f.topic)));
    const stop = entry.mutateStop ? entry.mutateStop(original) : original;
    assert.equal(f.ui.acceptStop(stop), undefined, entry.name);
    assert.equal(f.ui.binding("run")?.state === "CANCELLING", false, entry.name);
    assert.equal(f.store.activeRuns(7, 42)[0]?.requestId, "run", entry.name);
  }
});

test("accepted Native Stop synchronously fences response and queue ownership before cancellation I/O", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  f.sql.exec(
    "INSERT INTO responses(run,chat,thread,state) VALUES(?,?,?,?)",
    "run",
    7,
    42,
    "PENDING",
  );
  const stop = {
    chat: { id: 7, type: "private" },
    message_thread_id: 42,
    draft_id: drafts(f)[0]!.body.draft_id,
  };

  const admitted = f.ui.acceptStop(stop);

  assert.equal(admitted?.runId, "run");
  assert.equal(f.ui.binding("run")?.state, "CANCELLING");
  assert.equal([...f.sql.exec<{ state: string }>("SELECT state FROM runs WHERE request='run'")][0]?.state, "CANCELLING");
  assert.equal([...f.sql.exec<{ state: string }>("SELECT state FROM responses WHERE run='run'")][0]?.state, "FENCED");
  assert.equal([...f.sql.exec("SELECT request FROM active_runs WHERE request='run'")].length, 0);
  assert.equal(f.ui.canDeliver(f.topic, "run"), false);
  assert.equal(f.ui.acceptStop(stop), undefined);
});

test("wrong topic, old session/generation and recreated topic cannot route Stop", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  const stop = {
    chat: { id: 7, type: "private" },
    message_thread_id: 42,
    draft_id: drafts(f)[0]!.body.draft_id,
  };
  assert.equal(f.ui.acceptStop({ ...stop, message_thread_id: 43 }), undefined);
  assert.equal(f.ui.acceptStop({ ...stop, draft_id: stop.draft_id + 1 }), undefined);
  f.sql.exec(
    "UPDATE topics SET data=?",
    JSON.stringify({ ...f.topic, generation: 2, sessionId: "new" }),
  );
  assert.equal(f.ui.acceptStop(stop), undefined);
  f.advance();
  await f.ui.update(f.topic, "run", "stale");
  assert.equal(drafts(f).length, 1);
});
test("identical updates coalesce, quiet execution refreshes before expiry, 429 respects retry_after", async () => {
  let limited = true;
  const f = fixture((method) =>
    method === "getChat"
      ? Response.json({ ok: true, result: { id: 7, type: "private" } })
      : limited
        ? Response.json(
            { ok: false, error_code: 429, parameters: { retry_after: 3 } },
            { status: 429 },
          )
        : Response.json({ ok: true, result: true }),
  );
  await f.ui.start(f.topic, "run");
  const count = drafts(f).length;
  f.advance(2000);
  await f.ui.update(f.topic, "run", "");
  assert.equal(drafts(f).length, count);
  limited = false;
  f.advance(1100);
  await f.ui.update(f.topic, "run", "");
  f.advance();
  await f.ui.update(f.topic, "run", "");
  assert.equal(drafts(f).length, count + 1);
  f.advance(11000);
  await f.ui.update(f.topic, "run", "");
  assert.equal(drafts(f).length, count + 2);
});
test("definitive native rejection is durable and never retried or loses execution", async () => {
  const f = fixture((method) =>
    method === "getChat"
      ? Response.json({ ok: true, result: { id: 7, type: "private" } })
      : Response.json(
          { ok: false, error_code: 400, description: "Bad Request: drafts are not supported" },
          { status: 400 },
        ),
  );
  await f.ui.start(f.topic, "run");
  assert.equal(f.ui.binding("run")?.state, "UNSUPPORTED");
  f.advance(20000);
  await f.controller().update(f.topic, "run", "answer");
  assert.equal(drafts(f).length, 1);
  assert.equal(f.store.activeRuns(7, 42).length, 1);
});
test("in-flight draft completion after Stop cannot overwrite durable cancellation", async () => {
  let release!: (r: Response) => void;
  const f = fixture((method) =>
    method === "getChat"
      ? Response.json({ ok: true, result: { id: 7, type: "private" } })
      : new Promise((r) => {
          release = r;
        }),
  );
  const pending = f.ui.start(f.topic, "run");
  while (!release) await new Promise((r) => setTimeout(r, 0));
  const stop = {
    chat: { id: 7, type: "private" },
    message_thread_id: 42,
    draft_id: f.ui.binding("run")!.draftId,
  };
  assert.ok(f.controller().acceptStop(stop));
  release(Response.json({ ok: true, result: true }));
  await pending;
  assert.equal(f.ui.binding("run")?.state, "CANCELLING");
});
test("final delivery disables Stop only at the terminal outcome; duplicate completion is safe", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  f.ui.finalizing(f.topic, "run");
  f.advance();
  await f.ui.update(f.topic, "run", "ready");
  assert.equal(drafts(f).at(-1)!.body.can_stop, true);
  const count = f.sent.length;
  await f.ui.complete(f.topic, "run", "COMPLETED");
  assert.equal(f.ui.binding("run")?.state, "COMPLETED");
  assert.equal(f.sent.length, count); // Persisted final message clears Telegram's draft; never resurrect it.
  await f.ui.complete(f.topic, "run", "COMPLETED");
  assert.equal(f.sent.length, count);
});
test("General and supergroup Topics never acquire native generation", async () => {
  const f = fixture();
  await f.ui.start({ ...f.topic, threadId: 1 }, "run");
  await f.ui.start({ ...f.topic, chatId: -100 }, "run");
  assert.equal(drafts(f).length, 0);
});

test("metadata timeout is retried after restart before publishing any native draft", async () => {
  let failing = true;
  const f = fixture((method) => {
    if (method === "getChat" && failing) throw new Error("network");
    return Response.json({
      ok: true,
      result: method === "getChat" ? { id: 7, type: "private" } : true,
    });
  });
  await f.ui.start(f.topic, "run");
  assert.equal(drafts(f).length, 0);
  failing = false;
  f.advance();
  await f.controller().start(f.topic, "run");
  assert.equal(f.sent.filter((s) => s.method === "getChat").length, 2);
  assert.equal(drafts(f).length, 1);
});
test("Core terminal callback holds queued runs behind native final delivery", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  f.store.enqueue(7, 42, "next_run", "next");
  f.store.recordCallback(7, 42, {
    runId: "run",
    streamNonce: "core",
    sequence: 1,
    event: { type: "session.idle" },
  });
  assert.equal(f.store.startNext(7, 42), undefined);
  assert.equal(f.ui.canDeliver(f.topic, "run"), true);
  const stop = {
    chat: { id: 7, type: "private" },
    message_thread_id: 42,
    draft_id: f.ui.binding("run")!.draftId,
  };
  assert.ok(f.ui.acceptStop(stop));
  assert.equal(f.store.startNext(7, 42), undefined);
  f.ui.cancelled("run");
  assert.equal(f.store.startNext(7, 42)?.requestId, "next_run");
});

test("admission heartbeat never replaces streamed answer with an empty snapshot", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  f.advance();
  await f.ui.update(f.topic, "run", "useful answer");
  f.advance(11000);
  await f.controller().start(f.topic, "run");
  await f.controller().update(f.topic, "run", "useful answer");
  assert.ok(JSON.stringify(drafts(f).at(-1)!.body).includes("useful answer"));
});
test("failed native run also holds queue until its presentation is finalized", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  f.store.enqueue(7, 42, "next_run", "next");
  f.store.failRun(7, 42, "run", "failure");
  assert.equal(f.store.startNext(7, 42), undefined);
});

test("format fallback rechecks run ownership after an awaited rich rejection", async () => {
  let owned = true;
  let calls = 0;
  const telegram = new CloudTelegram("synthetic", async () => {
    calls++;
    owned = false;
    return Response.json(
      { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" },
      { status: 400 },
    );
  });
  const { renderTelegramParts } = await import("../src/bot/render/pipeline.js");
  await assert.rejects(
    telegram.sendPart(7, 42, renderTelegramParts("**answer**")[0]!, () => owned),
    /run_ui_fenced/,
  );
  assert.equal(calls, 1);
});
test("a deleted Topic rejection does not disable native drafts in another Topic", async () => {
  const f = fixture((method) =>
    method === "getChat"
      ? Response.json({ ok: true, result: { id: 7, type: "private" } })
      : Response.json(
          { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
          { status: 400 },
        ),
  );
  await f.ui.start(f.topic, "run");
  const capability = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='native-capability:7'"),
  ][0];
  assert.notEqual(capability?.data, JSON.stringify("unsupported"));
});

test("unsupported fallback still fences Topic replacement before final delivery", async () => {
  const f = fixture((method) =>
    method === "getChat"
      ? Response.json({ ok: true, result: { id: 7, type: "private" } })
      : Response.json(
          { ok: false, error_code: 404, description: "Not Found: method not found" },
          { status: 404 },
        ),
  );
  await f.ui.start(f.topic, "run");
  f.sql.exec(
    "UPDATE topics SET data=?",
    JSON.stringify({ ...f.topic, generation: 2, sessionId: "replacement" }),
  );
  assert.equal(f.ui.canDeliver(f.topic, "run"), false);
});
test("model thinking after an answer chunk stays distinct from answer streaming", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  f.ui.capture(
    f.topic,
    "run",
    part("new_thinking", "reasoning", { text: "hidden", time: { start: 1 } }),
  );
  f.advance();
  await f.ui.update(f.topic, "run", "old partial answer");
  assert.equal(f.ui.binding("run")!.state, "THINKING");
});

test("accepted persistent interaction restores the same native draft immediately", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  const telegram = new CloudTelegram(
    "synthetic",
    async () => Response.json({ ok: true, result: { message_id: 1 } }),
    async () => {
      await f.ui.restore(f.topic, "run", "");
    },
  );
  await telegram.call("sendMessage", {
    chat_id: 7,
    message_thread_id: 42,
    text: "Permission requested",
  });
  assert.equal(drafts(f).length, 2);
  assert.equal(drafts(f)[1]!.body.draft_id, drafts(f)[0]!.body.draft_id);
  assert.equal(drafts(f)[1]!.body.can_stop, true);
});

test("uncertain final receipt retains refreshable ownership after restart", async () => {
  const f = fixture();
  await f.ui.start(f.topic, "run");
  f.ui.finalizing(f.topic, "run");
  f.sql.exec("UPDATE runs SET state='FINALIZING' WHERE request='run'");
  f.store.enqueue(7, 42, "next", "next");
  assert.equal(f.controller().finalizingBindings()[0]?.runId, "run");
  f.advance(11000);
  await f.controller().update(f.topic, "run", "final response");
  assert.equal(drafts(f).at(-1)!.body.can_stop, true);
  assert.equal(f.store.startNext(7, 42), undefined);
});

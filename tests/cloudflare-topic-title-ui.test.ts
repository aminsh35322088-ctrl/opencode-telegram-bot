import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type SqlDatabase } from "../src/cloudflare/control-store.js";
import { CloudTelegram } from "../src/cloudflare/telegram.js";
import { CloudTopicTitleUi } from "../src/cloudflare/topic-title-ui.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...bindings) as never,
  };
  const store = new ControlStore(sql, (action) => action());
  store.putBackend({
    backendId: "a",
    workspaceId: "w",
    credential: "encrypted",
    region: "eu",
    desiredMaximumWorkers: 10,
    maxWorkersPerProject: 5,
    enabled: true,
  });
  const job = store.reserveAllocation("topic", -100);
  store.ready(job.workerId, job.generation, "synthetic");
  const topic = store.bindTopic(job.jobId, 42, "session");
  let now = 100_000;
  let deliver: () => Promise<Response> = async () => Response.json({ ok: true, result: true });
  const requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const telegram = new CloudTelegram("synthetic", async (url, init) => {
    requests.push({
      method: String(url).split("/").at(-1)!,
      payload: JSON.parse(String(init?.body)),
    });
    return deliver();
  });
  const restart = () => new CloudTopicTitleUi(sql, store, telegram, () => now);
  const optionsKey = `topic:${topic.chatId}:${topic.threadId}:${topic.generation}`;
  const options = () =>
    JSON.parse(
      [...sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", optionsKey)][0]
        ?.data ?? "{}",
    );
  const setOptions = (value: Record<string, unknown>) =>
    sql.exec(
      "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      optionsKey,
      JSON.stringify(value),
    );
  return {
    sql,
    store,
    topic,
    requests,
    restart,
    options,
    setOptions,
    ui: restart(),
    advance: (ms: number) => {
      now += ms;
    },
    deliver: (action: () => Promise<Response>) => {
      deliver = action;
    },
  };
}
function event(title: unknown, info: Record<string, unknown> = {}) {
  return { type: "session.updated", properties: { info: { id: "session", title, ...info } } };
}


test("automatic Telegram titles wait for an admitted OpenCode session title", async () => {
  const f = fixture();
  f.setOptions({ title: "#3", titleSource: "auto" });
  await f.ui.flush();
  assert.equal(f.requests.length, 0);
  assert.equal(f.options().title, "#3");
});

test("an admitted Core session title edits only its Telegram topic and persists its display name", async () => {
  const f = fixture();
  f.setOptions({ model: "provider/model" });
  assert.equal(f.ui.capture(f.topic, event("Fix checkout totals")), true);
  await f.restart().flush();
  assert.deepEqual(f.requests, [
    {
      method: "editForumTopic",
      payload: { chat_id: -100, message_thread_id: 42, name: "Fix checkout totals" },
    },
  ]);
  assert.deepEqual(f.options(), {
    model: "provider/model",
    title: "Fix checkout totals",
    titleSource: "auto",
  });
});

test("foreign and child session titles cannot rename the parent topic", async () => {
  const f = fixture();
  for (const info of [{ id: "foreign" }, { parentID: "session" }, { parentID: "foreign" }])
    assert.equal(f.ui.capture(f.topic, event("Foreign title", info)), false);
  assert.equal(
    f.ui.capture(f.topic, {
      type: "message.updated",
      properties: { info: { id: "session", title: "User title" } },
    }),
    false,
  );
  await f.ui.flush();
  assert.equal(f.requests.length, 0);
});

test("empty, Core default, malformed and excessively large titles are ignored", async () => {
  const f = fixture();
  for (const title of [
    "",
    "  ",
    42,
    "New session - 2026-10-09T00:00:00.000Z",
    "Child session - 2026-10-09T00:00:00.000Z",
    "New session",
    "a".repeat(4097),
  ])
    assert.equal(f.ui.capture(f.topic, event(title)), false);
  await f.ui.flush();
  assert.equal(f.requests.length, 0);
});

test("titles remove controls and fit Telegram's 128 character limit without splitting emoji", async () => {
  const f = fixture();
  f.ui.capture(f.topic, event("\u0000  Fix\n checkout\u202e \t" + "🚀".repeat(130)));
  await f.ui.flush();
  const title = String(f.requests[0]?.payload.name);
  assert.equal([...title].length, 128);
  assert.ok(title.startsWith("Fix checkout "));
  assert.ok(title.endsWith("🚀"));
  assert.doesNotMatch(title, /[\u0000-\u001f\u202e]/);
});

test("existing and explicitly manual names remain authoritative", async () => {
  for (const titleSource of [undefined, "manual"]) {
    const f = fixture();
    f.setOptions({ title: "My project", ...(titleSource ? { titleSource } : {}) });
    assert.equal(f.ui.capture(f.topic, event("Generated title")), false);
    await f.ui.flush();
    assert.equal(f.requests.length, 0);
    assert.equal(f.options().title, "My project");
  }
});

test("manual rename after capture cancels the pending automatic edit", async () => {
  const f = fixture();
  f.ui.capture(f.topic, event("Generated title"));
  f.setOptions({ title: "Manual title", titleSource: "manual" });
  await f.restart().flush();
  assert.equal(f.requests.length, 0);
  assert.equal(f.options().title, "Manual title");
});

test("duplicate events and restart do not repeat a successful edit", async () => {
  const f = fixture();
  assert.equal(f.ui.capture(f.topic, event("Generated title")), true);
  assert.equal(f.ui.capture(f.topic, event("Generated title")), false);
  await f.restart().flush();
  assert.equal(f.restart().capture(f.topic, event("Generated title")), false);
  await f.restart().flush();
  assert.equal(f.requests.length, 1);
});

test("a later Core title updates an automatically named topic", async () => {
  const f = fixture();
  f.ui.capture(f.topic, event("First title"));
  await f.ui.flush();
  f.ui.capture(f.topic, event("Improved title"));
  await f.ui.flush();
  assert.deepEqual(
    f.requests.map((r) => r.payload.name),
    ["First title", "Improved title"],
  );
  assert.equal(f.options().title, "Improved title");
});

test("a fenced generation cancels pending delivery and rejects old captures after restart", async () => {
  const f = fixture();
  f.ui.capture(f.topic, event("Old title"));
  f.store.fenceTopic(f.topic.chatId, f.topic.threadId);
  await f.restart().flush();
  assert.equal(f.restart().capture(f.topic, event("Old title")), false);
  assert.equal(f.requests.length, 0);
});

test("a changed session or worker at the same generation cancels delivery", async () => {
  for (const change of [{ sessionId: "replacement" }, { workerId: "replacement" }]) {
    const f = fixture();
    f.ui.capture(f.topic, event("Old title"));
    f.sql.exec(
      "UPDATE topics SET data=? WHERE chat=? AND thread=?",
      JSON.stringify({ ...f.topic, ...change }),
      f.topic.chatId,
      f.topic.threadId,
    );
    await f.restart().flush();
    assert.equal(f.requests.length, 0);
  }
});

test("General and inactive topics never accept generated titles", async () => {
  const f = fixture();
  assert.equal(f.ui.capture({ ...f.topic, threadId: 1 }, event("General title")), false);
  assert.equal(f.ui.capture({ ...f.topic, state: "FENCED" }, event("Inactive title")), false);
  await f.ui.flush();
  assert.equal(f.requests.length, 0);
});

test("rate limiting survives restart and respects Telegram retry_after", async () => {
  const f = fixture();
  f.deliver(async () =>
    Response.json({ ok: false, error_code: 429, parameters: { retry_after: 30 } }, { status: 429 }),
  );
  f.ui.capture(f.topic, event("Generated title"));
  await f.ui.flush();
  f.advance(29_999);
  await f.restart().flush();
  assert.equal(f.requests.length, 1);
  f.deliver(async () => Response.json({ ok: true, result: true }));
  f.advance(1);
  await f.restart().flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.options().title, "Generated title");
});

test("ambiguous transport failure retries only editForumTopic and remains bounded", async () => {
  const f = fixture();
  f.deliver(async () => {
    throw new Error("network unavailable");
  });
  f.ui.capture(f.topic, event("Generated title"));
  for (let i = 0; i < 10; i++) {
    await f.restart().flush();
    f.restart().capture(f.topic, event("Generated title"));
    f.advance(120_000);
  }
  assert.equal(f.requests.length, 5);
  assert.ok(f.requests.every((r) => r.method === "editForumTopic"));
  assert.equal(f.options().title, undefined);
});

test("a rejected edit is terminal instead of retrying forever", async () => {
  const f = fixture();
  f.deliver(async () => Response.json({ ok: false, error_code: 400 }, { status: 400 }));
  f.ui.capture(f.topic, event("Generated title"));
  await f.ui.flush();
  f.advance(120_000);
  await f.restart().flush();
  assert.equal(f.requests.length, 1);
});

test("fencing while Telegram is in flight cannot update replacement display state", async () => {
  const f = fixture();
  f.deliver(async () => {
    f.store.fenceTopic(f.topic.chatId, f.topic.threadId);
    return Response.json({ ok: true, result: true });
  });
  f.ui.capture(f.topic, event("Old title"));
  await f.ui.flush();
  assert.equal(f.options().title, undefined);
});

test("a newer captured title while an edit is in flight remains pending", async () => {
  const f = fixture();
  f.deliver(async () => {
    f.ui.capture(f.topic, event("Newest title"));
    return Response.json({ ok: true, result: true });
  });
  f.ui.capture(f.topic, event("First title"));
  await f.ui.flush();
  f.deliver(async () => Response.json({ ok: true, result: true }));
  await f.restart().flush();
  assert.deepEqual(
    f.requests.map((r) => r.payload.name),
    ["First title", "Newest title"],
  );
  assert.equal(f.options().title, "Newest title");
});

test("a failed topic edit does not block another topic's title", async () => {
  const f = fixture();
  const job = f.store.reserveAllocation("other-topic", -100);
  f.store.ready(job.workerId, job.generation, "synthetic");
  const other = f.store.bindTopic(job.jobId, 43, "other-session");
  f.ui.capture(f.topic, event("First title"));
  f.ui.capture(other, event("Other title", { id: "other-session" }));
  let attempt = 0;
  f.deliver(async () =>
    ++attempt === 1
      ? Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: 30 } },
          { status: 429 },
        )
      : Response.json({ ok: true, result: true }),
  );
  await f.ui.flush();
  assert.deepEqual(
    f.requests.map((r) => r.payload.message_thread_id),
    [42, 43],
  );
  const row = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", "topic:-100:43:1"),
  ][0]!;
  assert.equal(JSON.parse(row.data).title, "Other title");
  assert.equal(f.options().title, undefined);
});

test("a manual rename during delivery keeps its display state authoritative", async () => {
  const f = fixture();
  f.deliver(async () => {
    f.setOptions({ title: "Manual title", titleSource: "manual" });
    return Response.json({ ok: true, result: true });
  });
  f.ui.capture(f.topic, event("Generated title"));
  await f.ui.flush();
  await f.restart().flush();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.options(), { title: "Manual title", titleSource: "manual" });
});

test("an ambiguous successful edit settles through Telegram's unchanged-topic receipt", async () => {
  const f = fixture();
  f.deliver(async () => {
    throw new Error("response lost");
  });
  f.ui.capture(f.topic, event("Generated title"));
  await f.ui.flush();
  f.advance(1000);
  f.deliver(async () =>
    Response.json(
      { ok: false, error_code: 400, description: "Bad Request: TOPIC_NOT_MODIFIED" },
      { status: 400 },
    ),
  );
  await f.restart().flush();
  await f.restart().flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.options().title, "Generated title");
});

test("worker generation fencing suppresses an otherwise unchanged topic", async () => {
  const f = fixture();
  f.ui.capture(f.topic, event("Old title"));
  const worker = f.store.worker(f.topic.workerId)!;
  f.sql.exec(
    "UPDATE workers SET data=? WHERE id=?",
    JSON.stringify({ ...worker, generation: worker.generation + 1 }),
    worker.workerId,
  );
  await f.restart().flush();
  assert.equal(f.requests.length, 0);
});

test("nextDue exposes durable retry deadlines and excludes finished titles", async () => {
  const f = fixture();
  assert.equal(f.ui.nextDue(), undefined);
  f.ui.capture(f.topic, event("Generated title"));
  assert.equal(f.restart().nextDue(), 100_000);
  f.deliver(async () =>
    Response.json({ ok: false, error_code: 429, parameters: { retry_after: 30 } }, { status: 429 }),
  );
  await f.ui.flush();
  assert.equal(f.restart().nextDue(), 130_000);
  f.advance(30_000);
  f.deliver(async () => Response.json({ ok: true, result: true }));
  await f.restart().flush();
  assert.equal(f.restart().nextDue(), undefined);
});

test("a long Telegram retry_after is honored rather than shortened", async () => {
  const f = fixture();
  f.deliver(async () =>
    Response.json(
      { ok: false, error_code: 429, parameters: { retry_after: 172_800 } },
      { status: 429 },
    ),
  );
  f.ui.capture(f.topic, event("Generated title"));
  await f.ui.flush();
  assert.equal(f.restart().nextDue(), 172_900_000);
  f.advance(86_400_000);
  await f.restart().flush();
  assert.equal(f.requests.length, 1);
});

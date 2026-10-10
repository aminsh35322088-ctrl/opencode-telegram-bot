import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ControlStore,
  type SqlDatabase,
  type FleetTopic,
} from "../src/cloudflare/control-store.js";
import { CloudTaskUi } from "../src/cloudflare/task-ui.js";

function fixture(threadId = 2) {
  const db = new DatabaseSync(":memory:");
  const queries: string[] = [];
  const sql: SqlDatabase = {
    exec: (q, ...v) => {
      queries.push(q);
      return db.prepare(q).all(...v) as never;
    },
  };
  const store = new ControlStore(sql, (fn) => fn());
  const topic: FleetTopic = {
    chatId: -100,
    threadId: 2,
    workerId: "worker",
    generation: 1,
    sessionId: "session",
    state: "ACTIVE",
  };
  const worker = {
    workerId: "worker",
    backendId: "backend",
    generation: 1,
    state: "BOUND_IDLE",
    revision: 1,
    chatId: -100,
    threadId: 2,
  };
  sql.exec("INSERT INTO workers VALUES(?,?,?)", "worker", "backend", JSON.stringify(worker));
  sql.exec("INSERT INTO topics VALUES(?,?,?,?)", -100, 2, "worker", JSON.stringify(topic));
  let clock = Date.parse("2026-10-08T10:00:00Z");
  const messages: string[] = [],
    prompts: string[] = [];
  const context = {
    sql,
    store,
    actorId: 7,
    chatId: -100,
    threadId,
    generation: 1,
    now: () => clock,
    button: (text: string, action: string, value?: string) => ({
      text,
      callback_data: JSON.stringify({ action, value }),
    }),
    prompt: async (kind: string) => {
      prompts.push(kind);
    },
    notice: async (text: string) => {
      messages.push(text);
    },
    menu: async (text: string) => {
      messages.push(text);
    },
  };
  const enqueue = async (t: FleetTopic, request: string, text: string) => {
    store.enqueue(t.chatId, t.threadId, request, text);
  };
  return {
    sql,
    store,
    context,
    ui: new CloudTaskUi(context),
    queries,
    messages,
    prompts,
    enqueue,
    setClock: (v: number) => {
      clock = v;
    },
    now: () => clock,
  };
}
const save = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
  f.ui.handle(
    "config_task_save",
    JSON.stringify({ id: "daily", prompt: "Check project", every: 60_000, ...extra }),
  );

test("schedule persists across UI restart and admits a durable occurrence once", async () => {
  const f = fixture();
  await save(f, { at: undefined, due: "2026-10-08T10:00:00Z" });
  const ui = new CloudTaskUi(f.context);
  await ui.tick(f.enqueue);
  await ui.tick(f.enqueue);
  const rows = [...f.sql.exec<{ request: string }>("SELECT request FROM runs")];
  assert.deepEqual(
    rows.map((r) => r.request),
    ["task_daily_1791453600000"],
  );
  assert.equal(ui.nextDue(), f.now() + 60_000);
});
test("General cannot create execution schedules", async () => {
  const f = fixture(1);
  await assert.rejects(save(f), /topic_required/);
  assert.equal([...f.sql.exec("SELECT data FROM ui_state")].length, 0);
});
test("generation fencing and deleted topic disable old tasks", async () => {
  const f = fixture();
  await save(f, { due: "2026-10-08T10:00:00Z" });
  f.sql.exec("DELETE FROM topics");
  await f.ui.tick(f.enqueue);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
  assert.equal(f.ui.nextDue(), undefined);
});
test("scheduled prompts join ordinary queue in order and do not overlap themselves", async () => {
  const f = fixture();
  f.store.enqueue(-100, 2, "ordinary", "Work A");
  assert.equal(f.store.startNext(-100, 2)?.requestId, "ordinary");
  await save(f, { due: "2026-10-08T10:00:00Z" });
  await f.ui.tick(f.enqueue);
  assert.equal(f.store.startNext(-100, 2), undefined);
  f.setClock(f.now() + 60_000);
  await f.ui.tick(f.enqueue);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 2);
  f.store.finishRun(-100, 2, "ordinary");
  assert.match(f.store.startNext(-100, 2)!.requestId, /^task_daily_/);
});
test("pause and deletion affect future occurrences without cancelling admitted turns", async () => {
  const f = fixture();
  await save(f, { due: "2026-10-08T10:00:00Z" });
  await f.ui.tick(f.enqueue);
  await f.ui.handle("config_task_toggle", "daily");
  f.setClock(f.now() + 60_000);
  await f.ui.tick(f.enqueue);
  assert.equal(f.ui.nextDue(), undefined);
  await f.ui.handle("config_task_delete", "daily");
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 1);
});
test("admission failure retains occurrence and retries with the same id", async () => {
  const f = fixture();
  await save(f, { due: "2026-10-08T10:00:00Z" });
  let first = "";
  await f.ui.tick(async (_t, id) => {
    first = id;
    throw new Error("temporarily_unavailable");
  });
  assert.equal(f.ui.nextDue(), f.now() + 60_000);
  f.setClock(f.now() + 60_000);
  await f.ui.tick(async (t, id, text) => {
    assert.equal(id, first);
    await f.enqueue(t, id, text);
  });
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 1);
});
test("strict task input rejects secrets, invalid ids, owner override and invalid intervals", async () => {
  const f = fixture();
  for (const extra of [
    { apiKey: "SECRET" },
    { workerId: "other" },
    { id: "../bad" },
    { every: 1 },
    { at: "yesterday", every: undefined },
  ])
    await assert.rejects(save(f, extra));
  assert.equal([...f.sql.exec("SELECT data FROM ui_state")].length, 0);
  assert.ok(!f.messages.join("").includes("SECRET"));
});
test("task menu opens the authorized durable form", async () => {
  const f = fixture();
  assert.equal(await f.ui.handle("task"), true);
  assert.deepEqual(f.prompts, ["config_task_schedule"]);
  assert.equal(await f.ui.handle("unrelated"), false);
});
test("worker generation change fences tasks even if topic row remains", async () => {
  const f = fixture();
  await save(f, { due: "2026-10-08T10:00:00Z" });
  const worker = f.store.worker("worker")!;
  f.sql.exec(
    "UPDATE workers SET data=? WHERE id=?",
    JSON.stringify({ ...worker, generation: 2 }),
    "worker",
  );
  await f.ui.tick(f.enqueue);
  assert.equal(f.ui.nextDue(), undefined);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});
test("foreign actor cannot edit, toggle, delete or see a scoped task", async () => {
  const f = fixture();
  await save(f);
  const other = new CloudTaskUi({ ...f.context, actorId: 8 });
  for (const action of ["config_task_toggle", "config_task_delete"])
    await assert.rejects(other.handle(action, "daily"), /task_not_found/);
  await assert.rejects(
    other.handle(
      "config_task_save",
      JSON.stringify({ id: "daily", prompt: "stolen", every: 60000 }),
    ),
    /task_owner_mismatch/,
  );
  await other.handle("tasklist");
  assert.equal(f.messages.at(-1), "No scheduled tasks in this topic.");
});
test("tick bounds admission at ten and one-time tasks stop after admission", async () => {
  const f = fixture();
  for (let n = 0; n < 12; n++)
    await save(f, { id: `once${n}`, every: undefined, at: "2026-10-08T10:00:00Z" });
  assert.equal(await f.ui.tick(f.enqueue), f.now());
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 10);
  assert.equal(await f.ui.tick(f.enqueue), undefined);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 12);
});
test("concurrent tick instances do not admit the same occurrence twice", async () => {
  const f = fixture();
  await save(f, { due: "2026-10-08T10:00:00Z" });
  let release!: () => void,
    count = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = f.ui.tick(async (topic, id, text) => {
    count++;
    await gate;
    await f.enqueue(topic, id, text);
  });
  const second = new CloudTaskUi(f.context).tick(f.enqueue);
  await second;
  release();
  await first;
  assert.equal(count, 1);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 1);
});
test("delete during awaited admission preserves the admitted queue entry and deletion", async () => {
  const f = fixture();
  await save(f, { due: "2026-10-08T10:00:00Z" });
  await f.ui.tick(async (topic, id, text) => {
    await f.ui.handle("config_task_delete", "daily");
    await f.enqueue(topic, id, text);
  });
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 1);
  assert.equal([...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task:%'")].length, 0);
});
test("editing during admission retains the admitted occurrence overlap fence", async () => {
  const f = fixture();
  await save(f, { due: "2026-10-08T10:00:00Z" });
  await f.ui.tick(async (topic, id, text) => {
    await save(f, { prompt: "Updated prompt", due: "2026-10-08T10:01:00Z" });
    await f.enqueue(topic, id, text);
  });
  f.setClock(f.now() + 60000);
  await f.ui.tick(f.enqueue);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 1);
});
test("save mutation is durably marked before a rate-limited acknowledgement and replay is skipped", async () => {
  const f = fixture();
  let marked = false,
    notices = 0;
  const context = {
    ...f.context,
    markCommitted: () => {
      assert.equal([...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task:%'")].length, 1);
      marked = true;
    },
    notice: async () => {
      notices++;
      assert.equal(marked, true);
      throw new Error("telegram_429");
    },
  };
  const value = JSON.stringify({ prompt: "Check project", every: 60000 });
  const ui = new CloudTaskUi(context);
  await assert.rejects(ui.handle("config_task_save", value), /telegram_429/);
  // Parent dispatch uses the durable receipt to skip already applied effects on update redelivery.
  if (!marked) await ui.handle("config_task_save", value);
  assert.equal([...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task:%'")].length, 1);
  assert.equal(notices, 1);
});
test("toggle and delete mark their SQL effects before acknowledgement", async () => {
  for (const action of ["config_task_toggle", "config_task_delete"]) {
    const f = fixture();
    await save(f);
    let marked = false;
    const ui = new CloudTaskUi({
      ...f.context,
      markCommitted: () => {
        const rows = [
          ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='task:daily'"),
        ];
        if (action === "config_task_delete") assert.equal(rows.length, 0);
        else assert.equal(JSON.parse(rows[0].data).enabled, false);
        marked = true;
      },
      notice: async () => {
        assert.equal(marked, true);
        throw new Error("telegram_429");
      },
    });
    await assert.rejects(ui.handle(action, "daily"), /telegram_429/);
    assert.equal(marked, true);
  }
});
test("invalid task mutation never marks a receipt", async () => {
  const f = fixture();
  let count = 0;
  const ui = new CloudTaskUi({
    ...f.context,
    markCommitted: () => {
      count++;
    },
  });
  await assert.rejects(
    ui.handle("config_task_save", JSON.stringify({ prompt: "Check project", every: 1 })),
  );
  await assert.rejects(ui.handle("config_task_delete", "missing"));
  assert.equal(count, 0);
});

test("guided task creation survives restart and requires explicit confirmation", async () => {
  const f = fixture();
  await f.ui.handle("task");
  assert.equal(f.prompts.at(-1), "config_task_schedule");
  await f.ui.handle("config_task_schedule", "every 5 minutes");
  assert.equal(f.prompts.at(-1), "config_task_body");
  const restarted = new CloudTaskUi(f.context);
  await restarted.handle("config_task_body", "بررسی وضعیت پروژه");
  assert.equal([...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task:%'")].length, 0);
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'")][0]
      .data,
  );
  await restarted.handle("config_task_confirm", draft.id);
  await restarted.handle("config_task_confirm", draft.id);
  const tasks = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task:%'"),
  ];
  assert.equal(tasks.length, 1);
  const task = JSON.parse(tasks[0].data);
  assert.equal(task.prompt, "بررسی وضعیت پروژه");
  assert.equal(task.every, 300000);
  assert.equal(task.due, f.now() + 300000);
  assert.equal(task.version, 1);
  assert.equal([...f.sql.exec("SELECT request FROM runs")].length, 0);
});

test("invalid guided schedule keeps form active without creating a task", async () => {
  const f = fixture();
  await f.ui.handle("task");
  await f.ui.handle("config_task_schedule", "every banana");
  assert.equal(f.prompts.at(-1), "config_task_schedule");
  assert.equal([...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task:%'")].length, 0);
  await f.ui.handle("config_task_schedule", "in 10 minutes");
  await f.ui.handle("config_task_body", "Check once");
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'")][0]
      .data,
  );
  await f.ui.handle("config_task_confirm", draft.id);
  const task = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task:%'")][0].data,
  );
  assert.equal(task.every, undefined);
  assert.equal(task.due, f.now() + 600000);
});

test("expired drafts reject confirmation without allocating execution", async () => {
  const f = fixture();
  await f.ui.handle("task");
  await f.ui.handle("config_task_schedule", "2026-10-09T10:00:00Z");
  await f.ui.handle("config_task_body", "Check once");
  const row = [
    ...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'"),
  ][0];
  assert.ok(row);
  const draft = JSON.parse(row.data);
  f.setClock(f.now() + 300001);
  await assert.rejects(f.ui.handle("config_task_confirm", draft.id), /task_draft_expired/);
  assert.equal([...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task:%'")].length, 0);
});

test("task wizard records accepted step before rate-limited Telegram acknowledgement", async () => {
  const f = fixture();
  await f.ui.handle("task");
  let committed = false;
  const context = {
    ...f.context,
    markCommitted: () => {
      committed = true;
    },
    prompt: async () => {
      throw new Error("telegram_429");
    },
  };
  await assert.rejects(
    new CloudTaskUi(context).handle("config_task_schedule", "every 5 minutes"),
    /telegram_429/,
  );
  assert.equal(committed, true);
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'")][0]
      .data,
  );
  assert.equal(draft.stage, "body");
});

test("long task text is preserved while confirmation preview remains bounded HTML", async () => {
  const f = fixture();
  await f.ui.handle("task");
  await f.ui.handle("config_task_schedule", "every 1 hour");
  const prompt = "<&".repeat(9000);
  await f.ui.handle("config_task_body", prompt);
  const preview = f.messages.at(-1)!;
  assert.ok(preview.length < 4000);
  assert.match(preview, /&lt;&amp;/);
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'")][0]
      .data,
  );
  await f.ui.handle("config_task_confirm", draft.id);
  const task = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task:%'")][0].data,
  );
  assert.equal(task.prompt, prompt);
});

test("one-time guided task cannot activate after its scheduled time has passed", async () => {
  const f = fixture();
  await f.ui.handle("task");
  await f.ui.handle("config_task_schedule", "2026-10-08T10:01:00Z");
  await f.ui.handle("config_task_body", "Check once");
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'")][0]
      .data,
  );
  f.setClock(f.now() + 120000);
  await assert.rejects(f.ui.handle("config_task_confirm", draft.id), /invalid_task_utc_time/);
  assert.equal([...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task:%'")].length, 0);
});

test("another actor or a replaced draft cannot confirm task setup", async () => {
  const f = fixture();
  await f.ui.handle("task");
  await f.ui.handle("config_task_schedule", "every 1 day");
  await f.ui.handle("config_task_body", "Check daily");
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'")][0]
      .data,
  );
  await assert.rejects(
    new CloudTaskUi({ ...f.context, actorId: 8 }).handle("config_task_confirm", draft.id),
    /task_draft_expired/,
  );
  await f.ui.handle("task");
  await assert.rejects(f.ui.handle("config_task_confirm", draft.id), /task_draft_mismatch/);
  assert.equal([...f.sql.exec("SELECT data FROM ui_state WHERE key LIKE 'task:%'")].length, 0);
});

test("each accepted task-wizard step renews its input deadline", async () => {
  const f = fixture();
  await f.ui.handle("task");
  f.setClock(f.now() + 240000);
  await f.ui.handle("config_task_schedule", "every 1 hour");
  f.setClock(f.now() + 120000);
  await f.ui.handle("config_task_body", "Check project");
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key LIKE 'task-draft:%'")][0]
      .data,
  );
  assert.equal(draft.stage, "confirm");
  assert.equal(draft.expires, f.now() + 300000);
});


test("task scheduler uses the ui_state primary-key prefix instead of LIKE scans", async () => {
  const f = fixture();
  await save(f, { due: "2026-10-08T10:01:00Z" });
  f.queries.length = 0;
  await f.ui.tick(f.enqueue);
  assert.equal(
    f.queries.some((query) => query.includes("key LIKE 'task:%'")),
    false,
    "alarm-driven task enumeration must not full-scan ui_state",
  );
  assert.ok(f.queries.some((query) => query.includes("key GLOB 'task:*'")));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type FleetTopic, type SqlDatabase } from "../src/cloudflare/control-store.js";
import { LegacyUiAdapter } from "../src/cloudflare/legacy-ui-adapter.js";
import { LegacySessionAdapter, normalizeWorkspacePath } from "../src/cloudflare/legacy-session-adapter.js";
import { buildRemoteLsBrowseView, buildRemoteLsFileView } from "../src/bot/menus/file-browser-menu.js";
import { buildMessagesListKeyboard, formatMessagesSelectText } from "../src/bot/menus/message-history-menu.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = { exec: (q, ...v) => db.prepare(q).all(...v) as never };
  const store = new ControlStore(sql, (fn) => fn());
  store.setGlobal({ configuration: { runtime: { model: "p/m" } }, defaults: {} }, "hash");
  const topic: FleetTopic = {
    chatId: -100,
    threadId: 42,
    workerId: "worker",
    generation: 4,
    sessionId: "session",
    state: "ACTIVE",
  };
  sql.exec("INSERT INTO topics VALUES(?,?,?,?)", topic.chatId, topic.threadId, topic.workerId, JSON.stringify(topic));
  const calls: Array<{ operation: string; payload: unknown }> = [];
  const results: Record<string, unknown> = {
    "session.get": { id: "session", title: "Topic title" },
    "session.messages": [
      { info: { id: "u1", role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "hello" }] },
      { info: { id: "a1", role: "assistant", time: { created: 2000 } }, parts: [{ type: "text", text: "hi" }] },
    ],
    "session.todos": [{ status: "pending", content: "Ship UI" }],
    "session.diff": [{ path: "src/a.ts", additions: 2, deletions: 1 }],
    "session.children": [{ id: "child", title: "Research" }],
    "session.child-messages": [{ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }],
    "file.list": [
      { type: "directory", name: "src", path: "src" },
      { type: "file", name: "README.md", path: "README.md", size: 42 },
    ],
    "file.read": { encoding: "utf8", content: "# readme", size: 8 },
  };
  const ui = new LegacyUiAdapter({
    sql,
    store,
    botVersion: "0.26.2",
    coreVersion: "1.18.33-bot.13-pre.25",
    rpc: async (_topic, operation, payload) => {
      calls.push({ operation, payload });
      return results[operation] as never;
    },
    commitGlobal: async () => {},
  });
  return { session: new LegacySessionAdapter(ui), ui, topic, calls, db };
}

test("workspace path normalization rejects traversal, absolute and NUL paths", () => {
  assert.equal(normalizeWorkspacePath("."), ".");
  assert.equal(normalizeWorkspacePath("src/../README.md"), "README.md");
  assert.equal(normalizeWorkspacePath("./src/index.ts"), "src/index.ts");
  for (const path of ["../secret", "/etc/passwd", "C:\\Windows\\x", "src/../../secret", "a\0b"])
    assert.throws(() => normalizeWorkspacePath(path), /invalid_workspace_path/);
});

test("session adapter keeps every read generation-fenced and maps signed Core RPC", async () => {
  const f = fixture();
  assert.equal((await f.session.session(f.topic) as any).title, "Topic title");
  assert.equal((await f.session.messages(f.topic)).length, 2);
  assert.equal((await f.session.todos(f.topic) as any[]).length, 1);
  assert.equal((await f.session.diff(f.topic) as any[])[0].path, "src/a.ts");
  assert.equal((await f.session.children(f.topic) as any[])[0].id, "child");
  assert.equal((await f.session.childMessages(f.topic, "child") as any[]).length, 1);
  assert.equal((await f.session.list(f.topic, "src/../.") as any[]).length, 2);
  assert.equal((await f.session.read(f.topic, "README.md") as any).content, "# readme");
  assert.deepEqual(f.calls.map((call) => call.operation), [
    "session.get", "session.messages", "session.todos", "session.diff", "session.children",
    "session.child-messages", "file.list", "file.read",
  ]);

  const stale = { ...f.topic, generation: 3 };
  await assert.rejects(f.session.list(stale, "."), /stale_generation/);
});

test("remote file browser reuses legacy single-panel labels without local filesystem access", () => {
  const view = buildRemoteLsBrowseView(
    [
      { type: "directory", name: "src", path: "src" },
      { type: "file", name: "README.md", path: "README.md", size: 42 },
    ],
    ".",
  );
  assert.match(view.text, /📁/);
  const labels = view.keyboard.inline_keyboard.flat().map((button) => button.text);
  assert.deepEqual(labels.slice(0, 2), ["📁 src", "📄 README.md"]);
  const file = buildRemoteLsFileView("README.md", 42, true);
  assert.match(file.text, /README\.md/);
  assert.equal(file.keyboard.inline_keyboard.flat().some((button) => /Download/.test(button.text)), true);
});

test("message history keeps legacy paginated inline list presentation", () => {
  const messages = [
    { id: "m1", text: "first message", created: Date.UTC(2026, 0, 1, 10, 0) },
    { id: "m2", text: "second message", created: Date.UTC(2026, 0, 1, 11, 0) },
  ];
  const keyboard = buildMessagesListKeyboard(messages, 0, 8);
  assert.match(formatMessagesSelectText(0), /message|select|choose/i);
  const labels = keyboard.inline_keyboard.flat().map((button) => button.text);
  assert.equal(labels.some((label) => label.includes("first message")), true);
  assert.equal(labels.some((label) => label.includes("second message")), true);
});

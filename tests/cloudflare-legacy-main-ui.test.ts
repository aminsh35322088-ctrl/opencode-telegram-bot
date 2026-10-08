import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type SqlDatabase } from "../src/cloudflare/control-store.js";
import { LegacyUiAdapter } from "../src/cloudflare/legacy-ui-adapter.js";
import {
  LegacyMainUi,
  renderLegacyMainStatus,
  type LegacyPanel,
} from "../src/cloudflare/legacy-main-ui.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = { exec: (q, ...v) => db.prepare(q).all(...v) as never };
  const store = new ControlStore(sql, (fn) => fn());
  store.setGlobal(
    { configuration: { runtime: { model: "opencode/big-pickle", agent: "build" } }, defaults: {} },
    "hash",
  );
  const adapter = new LegacyUiAdapter({
    sql,
    store,
    botVersion: "0.26.2",
    coreVersion: "1.18.33-bot.13-pre.25",
    rpc: async () => undefined as never,
    commitGlobal: async () => {},
  });
  const calls: Array<{ method: string; payload: Record<string, any> }> = [];
  let nextMessageId = 100;
  let failPinFor: number | undefined;
  const telegram = {
    call: async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
      calls.push({ method, payload: payload as Record<string, any> });
      if (method === "sendMessage") return { message_id: nextMessageId++ } as T;
      if (method === "pinChatMessage" && payload.message_id === failPinFor)
        throw new Error("pin_failed");
      return true as T;
    },
  };
  const ui = new LegacyMainUi(adapter, telegram as never);
  return {
    ui,
    adapter,
    calls,
    failNextPin() {
      failPinFor = nextMessageId;
    },
  };
}

test("legacy Main status preserves the recognizable pre-Cloudflare welcome panel", () => {
  const text = renderLegacyMainStatus({
    botVersion: "0.26.2",
    coreVersion: "1.18.33-bot.13-pre.25",
    model: "opencode/big-pickle",
    agent: "build",
  });
  assert.match(text, /⚡ <b>OpenCode Telegram<\/b>/);
  assert.match(text, /🟢 <b>Ready<\/b>/);
  assert.match(text, /🤖 Bot <b>v0\.26\.2<\/b>/);
  assert.match(text, /🧠 OpenCode <b>v1\.18\.33<\/b>/);
  assert.match(text, /opencode\/big-pickle/);
  assert.match(text, /🛠️ build/);
  assert.match(text, /Build, debug and control OpenCode directly from Telegram/);
});

test("/start replacement leaves exactly one durable pinned canonical Main panel", async () => {
  const f = fixture();
  await f.ui.replaceCanonicalMainPanel(-100, 7);
  const first = f.adapter.getUiState<{ messageId: number }>("legacy:main:-100");
  assert.equal(first?.messageId, 100);
  const firstSend = f.calls.find((call) => call.method === "sendMessage")!;
  assert.match(firstSend.payload.text, /OpenCode Telegram/);
  const buttons = firstSend.payload.reply_markup.inline_keyboard.flat().map((button: any) => button.text);
  assert.deepEqual(buttons, ["💬 New Chat", "🕘 History", "⚙️ Main Settings"]);
  assert.ok(f.calls.some((call) => call.method === "pinChatMessage" && call.payload.message_id === 100));

  f.calls.length = 0;
  await f.ui.replaceCanonicalMainPanel(-100, 7);
  const second = f.adapter.getUiState<{ messageId: number }>("legacy:main:-100");
  assert.equal(second?.messageId, 101);
  assert.ok(f.calls.some((call) => call.method === "unpinChatMessage" && call.payload.message_id === 100));
  assert.ok(f.calls.some((call) => call.method === "deleteMessage" && call.payload.message_id === 100));
});

test("legacy inline navigation edits the active canonical panel instead of spamming messages", async () => {
  const f = fixture();
  await f.ui.replaceCanonicalMainPanel(-100, 7);
  f.calls.length = 0;
  const panel: LegacyPanel = {
    text: "⚙️ <b>Main Settings</b>",
    rows: [[{ text: "← Back", callback_data: "main:home" }]],
  };
  await f.ui.editCanonicalPanel(-100, undefined, panel);
  assert.equal(f.calls.filter((call) => call.method === "editMessageText").length, 1);
  assert.equal(f.calls.filter((call) => call.method === "sendMessage").length, 0);
  assert.equal(f.calls[0]?.payload.message_id, 100);
});

test("failed replacement pin keeps the last known-good canonical panel", async () => {
  const f = fixture();
  await f.ui.replaceCanonicalMainPanel(-100, 7);
  f.calls.length = 0;
  f.failNextPin();
  await assert.rejects(f.ui.replaceCanonicalMainPanel(-100, 7), /pin_failed/);
  assert.equal(f.adapter.getUiState<{ messageId: number }>("legacy:main:-100")?.messageId, 100);
  assert.ok(f.calls.some((call) => call.method === "deleteMessage" && call.payload.message_id === 101));
});

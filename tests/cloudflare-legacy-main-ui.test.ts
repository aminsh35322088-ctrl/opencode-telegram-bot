import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type SqlDatabase } from "../src/cloudflare/control-store.js";
import { LegacyUiAdapter } from "../src/cloudflare/legacy-ui-adapter.js";
import { LegacyMainUi, renderLegacyMainStatus } from "../src/cloudflare/legacy-main-ui.js";

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
  return { ui: new LegacyMainUi(adapter), adapter };
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

test("Home deep link targets the durable single panel in a supergroup", () => {
  const f = fixture();
  f.adapter.setUiState("legacy:main:-1001234567890", { messageId: 100, actorId: 7 });
  assert.equal(f.ui.mainPanelLink(-1001234567890), "https://t.me/c/1234567890/100");
  assert.equal(f.ui.mainPanelLink(1802392273), undefined);
});

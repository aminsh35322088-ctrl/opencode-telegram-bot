import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToolActivity } from "../src/bot/streaming/tool-activity-renderer.js";
import { ToolCallStreamer } from "../src/bot/streaming/tool-call-streamer.js";

test("tool activity from default, subagent and todo streams is aggregated into one Telegram message", async () => {
  const sent: Array<{ id: number; text: string }> = [];
  const edited: Array<{ id: number; text: string }> = [];
  let nextId = 10;
  const streamer = new ToolCallStreamer({
    throttleMs: 60_000,
    sendText: async (_session, text) => {
      const id = nextId++;
      sent.push({ id, text });
      return id;
    },
    editText: async (_session, id, text) => {
      edited.push({ id, text });
    },
    deleteText: async () => {},
  });
  streamer.append("session", "🔎 Grep · 9 matches", "default");
  streamer.append("session", "🧠 Skill · brainstorming", "subagent");
  streamer.append("session", "☑️ Todo · verify build", "todo");
  await streamer.flushSession("session", "test");
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 0);
  assert.match(sent[0]!.text, /Grep/);
  assert.match(sent[0]!.text, /Skill/);
  assert.match(sent[0]!.text, /Todo/);

  streamer.append("session", "✏️ Edit · src/index.ts", "default");
  await streamer.flushSession("session", "after_reasoning_phase");
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0]!.text, /Edit/);
  streamer.clearSession("session", "test_cleanup");
});


for (const [name, text] of [
  ["credential crossing a Telegram chunk boundary", "x".repeat(3985) + " TOKEN=SENSITIVE_TAIL"],
  ["redaction expansion before message bounds", "token=x ".repeat(490)],
] as const) {
  test(`tool activity protects ${name} across rich and fallback transport`, async () => {
    const delivered: ReturnType<typeof renderToolActivity>[] = [];
    const streamer = new ToolCallStreamer({
      throttleMs: 60_000,
      sendText: async (_session, part) => { delivered.push(renderToolActivity(part)); return delivered.length; },
      editText: async (_session, _id, part) => { delivered.push(renderToolActivity(part)); },
      deleteText: async () => {},
    });
    try {
      streamer.append("session", text);
      await streamer.flushSession("session", "security_regression");
      assert.ok(delivered.length > 0);
      for (const part of delivered) {
        assert.doesNotMatch(part.fallbackText, /SENSITIVE|E_TAIL/);
        assert.doesNotMatch(JSON.stringify(part.blocks), /SENSITIVE|E_TAIL/);
        assert.ok(part.fallbackText.length <= 4096, `fallback exceeds Telegram limit: ${part.fallbackText.length}`);
      }
    } finally { streamer.clearSession("session", "cleanup"); }
  });
}

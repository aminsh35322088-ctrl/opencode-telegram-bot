import assert from "node:assert/strict";
import { test } from "node:test";
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

test("tool activity rendering uses one expandable blockquote and redacts credential-shaped values", async () => {
  const module = (await import("../src/bot/streaming/tool-call-streamer.js")) as any;
  assert.equal(typeof module.renderToolActivity, "function");
  const rendered = module.renderToolActivity("💻 Shell · TOKEN=super-secret\n🔎 Grep · done");
  assert.doesNotMatch(rendered.text, /super-secret/);
  assert.match(rendered.text, /REDACTED/);
  assert.deepEqual(rendered.entities, [
    { type: "expandable_blockquote", offset: 0, length: rendered.text.length },
  ]);
});

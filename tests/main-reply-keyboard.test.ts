import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMainKeyboard,
  createTopicKeyboard,
} from "../src/bot/keyboards/main-reply-keyboard.js";

const rows = (keyboard: { keyboard: Array<Array<{ text: string }>> }) =>
  keyboard.keyboard.map((row) => row.map((button) => button.text)).filter((row) => row.length > 0);

test("legacy General reply keyboard remains New Chat / History / Main Settings", () => {
  const keyboard = createMainKeyboard({ providerID: "p", modelID: "m" });
  assert.deepEqual(rows(keyboard), [["💬 New Chat"], ["🕘 History", "⚙️ Main Settings"]]);
});

test("legacy Topic reply keyboard changes run controls without changing the base layout", () => {
  const idle = createTopicKeyboard({
    currentModel: { providerID: "p", modelID: "gpt-5", name: "GPT 5" },
  });
  assert.deepEqual(rows(idle), [
    ["📦 Compact: OFF"],
    ["🧠 GPT 5"],
    ["🗑️ Delete Chat", "⚙️ Topic Settings"],
  ]);

  const running = createTopicKeyboard({
    running: true,
    currentModel: { providerID: "p", modelID: "gpt-5", name: "GPT 5" },
  });
  assert.deepEqual(rows(running)[0], ["⏸️ Pause", "🛑 Abort"]);

  const paused = createTopicKeyboard({
    paused: true,
    running: true,
    currentModel: { providerID: "p", modelID: "gpt-5", name: "GPT 5" },
  });
  assert.deepEqual(rows(paused)[0], ["▶️ Resume", "🛑 Abort"]);
});

test("qualified native Stop hides only the user-facing execution controls", () => {
  const keyboard = createTopicKeyboard({
    running: true,
    nativeStop: true,
    currentModel: { providerID: "p", modelID: "m" },
  });
  const text = JSON.stringify(keyboard.keyboard);
  assert.equal(/Pause|Resume|Abort/.test(text), false);
  assert.match(text, /Compact/);
  assert.match(text, /Delete Chat/);
  assert.match(text, /Topic Settings/);
});

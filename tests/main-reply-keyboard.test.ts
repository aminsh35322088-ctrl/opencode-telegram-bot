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

test("managed Topic ReplyKeyboard has exactly three dynamic rows and no legacy run controls", () => {
  for (const state of [
    {},
    { running: true },
    { paused: true, running: true },
    { nativeStop: true, running: true },
  ]) {
    const keyboard = createTopicKeyboard({
      ...state,
      compactOutputMode: true,
      currentModel: { providerID: "p", modelID: "gpt-5", name: "GPT 5" },
    });
    assert.deepEqual(rows(keyboard), [
      ["📦 Compact: ON"],
      ["🧠 GPT 5"],
      ["🗑️ Delete Chat", "⚙️ Topic Settings"],
    ]);
    const markup = keyboard as unknown as { resize_keyboard?: boolean; is_persistent?: boolean };
    assert.equal(markup.resize_keyboard, true);
    assert.equal(markup.is_persistent, undefined);
    assert.equal(/Pause|Resume|Abort/.test(JSON.stringify(keyboard.keyboard)), false);
  }
});

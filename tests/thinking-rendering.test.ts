import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareThinkingPayload } from "../src/bot/messages/thinking-rendering.js";
import { t } from "../src/i18n/index.js";

const section = (text: string) => [{ id: "reason", title: "Reasoning", text }];
const firstBlock = (text: string, final = false) =>
  prepareThinkingPayload(section(text), { final })!.parts[0]!.blocks[0]! as any;

test("active visible reasoning stays a native thinking block while streaming", () => {
  assert.equal(firstBlock("short").type, "thinking");
  assert.equal(firstBlock("x".repeat(321)).type, "thinking");
});

test("every completed reasoning section becomes expandable regardless of length", () => {
  assert.equal(firstBlock("short", true).type, "expandable_blockquote");
  assert.equal(firstBlock("a\nb", true).type, "expandable_blockquote");
  assert.equal(firstBlock("x".repeat(321), true).type, "expandable_blockquote");
});

test("multiple sections share one live draft and one final quote payload", () => {
  const sections = [
    { id: "a", title: "Analysis", text: "First thought" },
    { id: "b", title: "Analysis", text: "Second thought" },
  ];
  const live = prepareThinkingPayload(sections)!;
  const completed = prepareThinkingPayload(sections, { final: true })!;

  assert.equal(live.parts.length, 1);
  assert.equal(completed.parts.length, 1);
  assert.equal(live.parts[0]!.fallbackText, `${t("bot.thinking")} — Analysis\nFirst thought\n\nSecond thought`);
  assert.equal(completed.parts[0]!.blocks[0]!.type, "expandable_blockquote");
});

test("provider think delimiters never appear in visible reasoning", () => {
  const payload = prepareThinkingPayload(section("<think>First</think>\n\n\nSecond</think>"))!;

  assert.equal(payload.parts[0]!.fallbackText, `${t("bot.thinking")} — Reasoning\nFirst\n\nSecond`);
  assert.equal(payload.parts[0]!.fallbackText.includes("</think>"), false);
});

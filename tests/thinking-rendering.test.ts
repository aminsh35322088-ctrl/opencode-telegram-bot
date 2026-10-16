import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareThinkingPayload } from "../src/bot/messages/thinking-rendering.js";

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

import assert from "node:assert/strict";
import { test } from "node:test";
import { isLongThinking, prepareThinkingPayload } from "../src/bot/messages/thinking-rendering.js";

const section = (text: string) => [{ id: "reason", title: "Reasoning", text }];
const firstBlock = (text: string, final = false) =>
  prepareThinkingPayload(section(text), { final })!.parts[0]!.blocks[0]! as any;

test("thinking threshold is long only above 320 chars or above four lines", () => {
  assert.equal(isLongThinking("x".repeat(320)), false);
  assert.equal(isLongThinking("x".repeat(321)), true);
  assert.equal(isLongThinking("a\nb\nc\nd"), false);
  assert.equal(isLongThinking("a\nb\nc\nd\ne"), true);
});

test("active visible reasoning is always a fixed open blockquote", () => {
  assert.equal(firstBlock("short").type, "blockquote");
  assert.equal(firstBlock("x".repeat(321)).type, "blockquote");
});

test("completed short reasoning stays open while completed long reasoning becomes expandable", () => {
  assert.equal(firstBlock("x".repeat(320), true).type, "blockquote");
  assert.equal(firstBlock("a\nb\nc\nd", true).type, "blockquote");
  assert.equal(firstBlock("x".repeat(321), true).type, "expandable_blockquote");
  assert.equal(firstBlock("a\nb\nc\nd\ne", true).type, "expandable_blockquote");
});

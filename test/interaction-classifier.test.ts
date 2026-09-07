import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "grammy";
import { classifyReplyKeyboardInteraction } from "../src/bot/interaction-classifier.js";

function context(messageText: string, rawReplyKeyboardText?: string): Context {
  return {
    message: { text: messageText },
    state: rawReplyKeyboardText === undefined ? {} : { rawReplyKeyboardText },
  } as unknown as Context;
}

test("classifies the raw Reply Keyboard label even after reply-context enrichment", async () => {
  const result = await classifyReplyKeyboardInteraction(
    context("Replying to @Chat Bot.\n\n⚙️ Topic Settings", "⚙️ Topic Settings"),
  );

  assert.equal(result.isControl, true);
  assert.equal(result.controlId, "topic-settings");
  assert.equal(result.text, "⚙️ Topic Settings");
});

test("falls back to the message text when no raw keyboard label is stashed", async () => {
  const result = await classifyReplyKeyboardInteraction(context("⚙️ Topic Settings"));

  assert.equal(result.isControl, true);
  assert.equal(result.controlId, "topic-settings");
});

test("does not classify an enriched ordinary prompt as a keyboard control", async () => {
  const result = await classifyReplyKeyboardInteraction(
    context("Replying to @Chat Bot.\n\nPlease explain this code"),
  );

  assert.equal(result.isControl, false);
});

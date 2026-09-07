import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getKeyboard: vi.fn(() => null),
  getStoredModel: vi.fn(() => ({ providerID: "", modelID: "", name: "" })),
  getTopicRuntimeContext: vi.fn(() => undefined),
  findTelegramTopicBindingByThread: vi.fn(async () => undefined),
}));

vi.mock("../../src/bot/keyboards/keyboard-manager.js", () => ({ keyboardManager: { getKeyboard: mocks.getKeyboard } }));
vi.mock("../../src/app/services/model-selection-service.js", () => ({ getStoredModel: mocks.getStoredModel }));
vi.mock("../../src/app/services/topic-runtime-context.js", () => ({ getTopicRuntimeContext: mocks.getTopicRuntimeContext }));
vi.mock("../../src/app/services/telegram-topic-store.js", () => ({ findTelegramTopicBindingByThread: mocks.findTelegramTopicBindingByThread }));

import type { Context } from "grammy";
import { classifyReplyKeyboardInteraction } from "../../src/bot/interaction-classifier.js";
import { MAIN_BUTTONS } from "../../src/bot/keyboards/main-reply-keyboard.js";

function context(messageText: string, rawReplyKeyboardText?: string): Context {
  return {
    message: { text: messageText },
    state: rawReplyKeyboardText === undefined ? {} : { rawReplyKeyboardText },
  } as unknown as Context;
}

const staticLabels: Array<[label: string, controlId: string]> = [
  [MAIN_BUTTONS.history, "history"],
  [MAIN_BUTTONS.newChat, "new-chat"],
  [MAIN_BUTTONS.mainSettings, "main-settings"],
  [MAIN_BUTTONS.topicSettings, "topic-settings"],
  [MAIN_BUTTONS.imageAi, "image-ai"],
  [MAIN_BUTTONS.deleteChat, "delete-chat"],
  [MAIN_BUTTONS.pause, "pause"],
  [MAIN_BUTTONS.resume, "resume"],
  [MAIN_BUTTONS.abort, "abort"],
  [MAIN_BUTTONS.compact(true), "compact"],
  [MAIN_BUTTONS.compact(false), "compact"],
  ["🧠 Model Center", "model-center"],
  ["❌ Cancel", "cancel"],
];

describe("classifyReplyKeyboardInteraction", () => {
  it.each(staticLabels)(
    "classifies %s as a control even when the message text is prefixed with reply context",
    async (label, controlId) => {
      const result = await classifyReplyKeyboardInteraction(
        context(`Replying to @Chat Bot.\n\n${label}`, label),
      );
      expect(result.isControl).toBe(true);
      expect(result.controlId).toBe(controlId);
    },
  );

  it("classifies the raw Reply Keyboard label even after reply-context enrichment", async () => {
    const result = await classifyReplyKeyboardInteraction(
      context("Replying to @Chat Bot.\n\n⚙️ Topic Settings", "⚙️ Topic Settings"),
    );
    expect(result.isControl).toBe(true);
    expect(result.controlId).toBe("topic-settings");
  });

  it("falls back to the message text when no raw Reply Keyboard label is stashed", async () => {
    const result = await classifyReplyKeyboardInteraction(context("⚙️ Topic Settings"));
    expect(result.isControl).toBe(true);
    expect(result.controlId).toBe("topic-settings");
  });

  it("does not classify an enriched ordinary prompt as a keyboard control", async () => {
    const result = await classifyReplyKeyboardInteraction(
      context("Replying to @Chat Bot.\n\nPlease explain this code"),
    );
    expect(result.isControl).toBe(false);
  });
});
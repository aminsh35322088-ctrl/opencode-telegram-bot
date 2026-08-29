import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { handleSettingsCallback } from "../../../src/bot/callbacks/settings-callback-handler.js";
import { buildAppearanceSettingsView, buildNotificationsSettingsView, buildSettingsMenuView, SETTINGS_COMPACT_OUTPUT_CALLBACK, SETTINGS_PROMPT_QUEUE_CALLBACK } from "../../../src/bot/menus/settings-menu.js";

const mocks = vi.hoisted(() => ({
  compact: false,
  queue: false,
}));

vi.mock("../../../src/app/stores/settings-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/app/stores/settings-store.js")>("../../../src/app/stores/settings-store.js");
  return {
    ...actual,
    getCompactOutputMode: () => mocks.compact,
    setCompactOutputMode: (value: boolean) => { mocks.compact = value; },
    getPromptQueueEnabled: () => mocks.queue,
    setPromptQueueEnabled: (value: boolean) => { mocks.queue = value; },
  };
});

describe("settings UI", () => {
  beforeEach(() => {
    mocks.compact = false;
    mocks.queue = false;
    interactionManager.clear("settings-test");
  });

  it("builds the current settings menu", () => {
    const view = buildSettingsMenuView();
    expect(view.text).toContain("Settings");
    expect(view.keyboard.inline_keyboard).toHaveLength(5);
  });

  it("exposes compact and notification settings", () => {
    const appearance = buildAppearanceSettingsView();
    const notifications = buildNotificationsSettingsView();
    expect(appearance.keyboard.inline_keyboard.flat().some((button) => button.text.includes("Compact output"))).toBe(true);
    expect(notifications.keyboard.inline_keyboard.flat().some((button) => button.text.includes("Prompt queue"))).toBe(true);
  });

  it("toggles compact output from the settings callback", async () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { menuKind: "settings", messageId: 10 } });
    const ctx = {
      callbackQuery: { data: SETTINGS_COMPACT_OUTPUT_CALLBACK, message: { message_id: 10 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;
    await handleSettingsCallback(ctx);
    expect(mocks.compact).toBe(true);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it("toggles prompt queue from the settings callback", async () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { menuKind: "settings", messageId: 10 } });
    const ctx = {
      callbackQuery: { data: SETTINGS_PROMPT_QUEUE_CALLBACK, message: { message_id: 10 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;
    await handleSettingsCallback(ctx);
    expect(mocks.queue).toBe(true);
  });
});

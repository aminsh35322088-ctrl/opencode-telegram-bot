import { beforeEach, describe, expect, it, vi } from "vitest";

const { showModelCenterMenu, ensureActiveInlineMenu } = vi.hoisted(() => ({
  showModelCenterMenu: vi.fn(),
  ensureActiveInlineMenu: vi.fn(),
}));

vi.mock("../../../src/bot/menus/model-center-menu.js", () => ({
  showModelCenterMenu,
}));

vi.mock("../../../src/bot/menus/inline-menu.js", () => ({
  replyWithInlineMenu: vi.fn(),
  appendInlineMenuCancelButton: vi.fn((keyboard: unknown) => keyboard),
  ensureActiveInlineMenu,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getModelSelectionLists: vi.fn(),
  fetchCurrentModel: vi.fn(),
}));

vi.mock("../../../src/bot/commands/mcp-catalog-command.js", () => ({ mcpsCommand: vi.fn() }));
vi.mock("../../../src/bot/commands/skills-catalog-command.js", () => ({ skillsCommand: vi.fn() }));
vi.mock("../../../src/bot/commands/command-catalog-command.js", () => ({ commandsCommand: vi.fn() }));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCompactOutputMode: vi.fn(),
  getMessageFormatMode: vi.fn(),
  getPromptQueueEnabled: vi.fn(),
  getResponseStreamingMode: vi.fn(),
  getSendDiffFileAttachments: vi.fn(),
  getShowAssistantRunFooter: vi.fn(),
  getShowThinkingContent: vi.fn(),
  setCompactOutputMode: vi.fn(),
  setMessageFormatMode: vi.fn(),
  setPromptQueueEnabled: vi.fn(),
  setResponseStreamingMode: vi.fn(),
  setSendDiffFileAttachments: vi.fn(),
  setShowAssistantRunFooter: vi.fn(),
  setShowThinkingContent: vi.fn(),
}));

import { handleSettingsCallback } from "../../../src/bot/callbacks/settings-callback-handler.js";
import { SETTINGS_MODEL_CALLBACK } from "../../../src/bot/menus/settings-menu.js";

describe("settings model selection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureActiveInlineMenu.mockResolvedValue(true);
    showModelCenterMenu.mockResolvedValue(undefined);
  });

  it("opens the Model Center view", async () => {
    const ctx = {
      callbackQuery: { data: SETTINGS_MODEL_CALLBACK },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("grammy").Context;

    await handleSettingsCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
    expect(showModelCenterMenu).toHaveBeenCalledOnce();
    expect(showModelCenterMenu).toHaveBeenCalledWith(ctx);
  });
});

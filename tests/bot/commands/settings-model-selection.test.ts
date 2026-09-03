import { beforeEach, describe, expect, it, vi } from "vitest";

const replyWithInlineMenu = vi.fn();
const getModelSelectionLists = vi.fn();
const fetchCurrentModel = vi.fn();

vi.mock("../../../src/bot/menus/inline-menu.js", () => ({
  replyWithInlineMenu,
  appendInlineMenuCancelButton: vi.fn((keyboard) => keyboard),
  ensureActiveInlineMenu: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getModelSelectionLists,
  fetchCurrentModel,
}));

vi.mock("../../../src/bot/commands/mcp-catalog-command.js", () => ({ mcpsCommand: vi.fn() }));
vi.mock("../../../src/bot/commands/skills-catalog-command.js", () => ({ skillsCommand: vi.fn() }));
vi.mock("../../../src/bot/commands/command-catalog-command.js", () => ({ commandsCommand: vi.fn() }));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCompactOutputMode: vi.fn().mockReturnValue(false),
  getMessageFormatMode: vi.fn().mockReturnValue("markdown"),
  getPromptQueueEnabled: vi.fn().mockReturnValue(true),
  getResponseStreamingMode: vi.fn().mockReturnValue("edit"),
  getSendDiffFileAttachments: vi.fn().mockReturnValue(false),
  getShowAssistantRunFooter: vi.fn().mockReturnValue(true),
  getShowThinkingContent: vi.fn().mockReturnValue(true),
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
    fetchCurrentModel.mockReturnValue({ providerID: "openai", modelID: "gpt-test", variant: "default" });
    getModelSelectionLists.mockResolvedValue({ favorites: [], recent: [] });
  });

  it("opens the real model selection view", async () => {
    const ctx = {
      callbackQuery: { data: SETTINGS_MODEL_CALLBACK },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    } as never;

    await handleSettingsCallback(ctx);

    expect(replyWithInlineMenu).toHaveBeenCalledOnce();
    const view = replyWithInlineMenu.mock.calls[0]?.[1];
    expect(view?.menuKind).toBe("model");
    expect(view?.text).toContain("🤖 Model");
    expect(view?.text).toContain("Choose the model for the current chat.");
  });
});


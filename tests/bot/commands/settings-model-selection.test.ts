import { beforeEach, describe, expect, it, vi } from "vitest";

const replyWithInlineMenu = vi.fn();
const getModelSelectionLists = vi.fn();
const fetchCurrentModel = vi.fn();

vi.mock("../../../src/bot/menus/inline-menu.js", () => ({
  replyWithInlineMenu,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getModelSelectionLists,
  fetchCurrentModel,
}));

import { showModelSelectionMenu } from "../../../src/bot/callbacks/model-selection-callback-handler.js";

describe("settings model selection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCurrentModel.mockReturnValue({ providerID: "openai", modelID: "gpt-test", variant: "default" });
    getModelSelectionLists.mockResolvedValue({ favorites: [], recent: [] });
  });

  it("opens the real model selection view", async () => {
    await showModelSelectionMenu({} as never);

    expect(replyWithInlineMenu).toHaveBeenCalledOnce();
    const view = replyWithInlineMenu.mock.calls[0]?.[1];
    expect(view?.menuKind).toBe("model");
    expect(view?.text).toContain("🤖 Model");
    expect(view?.text).toContain("Choose the model for the current chat.");
  });
});

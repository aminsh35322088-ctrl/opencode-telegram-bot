import { beforeEach, describe, expect, it, vi } from "vitest";

const replyWithInlineMenu = vi.fn();
const getAiRoleSelections = vi.fn();

vi.mock("../../../src/bot/menus/inline-menu.js", () => ({
  replyWithInlineMenu,
}));

vi.mock("../../../src/app/services/ai-role-selection-service.js", () => ({
  AI_ROLE_LABELS: {
    coding: "Coding AI",
    image: "Image AI",
    video: "Video AI",
    stt: "Speech-to-Text",
  },
  getAiRoleSelections,
  setAiRoleSelection: vi.fn(),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getProvidersForCapability: vi.fn(),
  getProviderModelsForCapability: vi.fn(),
}));

vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({
  listImageAiProviders: vi.fn(),
}));

vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  getGroqSttConfig: vi.fn(),
}));

import { showAiRulesMenu } from "../../../src/bot/callbacks/ai-role-selection-callback-handler.js";

describe("settings AI Rules route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAiRoleSelections.mockResolvedValue({});
  });

  it("opens the AI Rules view instead of the generic model selector", async () => {
    await showAiRulesMenu({} as never);

    expect(replyWithInlineMenu).toHaveBeenCalledOnce();
    const view = replyWithInlineMenu.mock.calls[0]?.[1];
    expect(view?.text).toContain("🧠 AI Rules");
    expect(view?.text).toContain("Coding AI");
  });
});

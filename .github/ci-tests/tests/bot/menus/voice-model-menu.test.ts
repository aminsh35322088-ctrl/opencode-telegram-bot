import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listUnifiedModelCatalog: vi.fn(),
  getCurrentTopicSettings: vi.fn(),
  getCurrentTopicCapabilityOverride: vi.fn(),
  getDefaultCapabilityModel: vi.fn(),
  setCurrentTopicCapabilityOverride: vi.fn(),
  setDefaultCapabilityModel: vi.fn(),
  setAiRoleSelection: vi.fn(),
}));
vi.mock("../../../src/app/services/unified-model-catalog-service.js", () => ({ listUnifiedModelCatalog: mocks.listUnifiedModelCatalog }));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentTopicSettings: mocks.getCurrentTopicSettings,
  getCurrentTopicCapabilityOverride: mocks.getCurrentTopicCapabilityOverride,
  getDefaultCapabilityModel: mocks.getDefaultCapabilityModel,
  setCurrentTopicCapabilityOverride: mocks.setCurrentTopicCapabilityOverride,
  setDefaultCapabilityModel: mocks.setDefaultCapabilityModel,
}));
vi.mock("../../../src/app/services/ai-role-selection-service.js", () => ({ setAiRoleSelection: mocks.setAiRoleSelection }));

import { buildVoiceModelSettingsView, clearVoiceModelMenuChoices, handleVoiceModelSettingsCallback } from "../../../src/bot/menus/voice-model-menu.js";

const sttModel = {
  providerID: "groq", providerName: "Groq", modelID: "whisper", modelName: "Whisper",
  capabilities: { operations: { speechToText: true } },
};
function context(data: string) {
  return { chat: { id: 1 }, callbackQuery: { data, message: { message_id: 4, message_thread_id: 10, chat: { id: 1 } } }, answerCallbackQuery: vi.fn().mockResolvedValue(undefined), editMessageText: vi.fn().mockResolvedValue(undefined) } as any;
}
function callbacks(view: Awaited<ReturnType<typeof buildVoiceModelSettingsView>>) { return view.keyboard.inline_keyboard.flat().flatMap((b) => "callback_data" in b ? [b.callback_data] : []); }

describe("Voice → Text model menu", () => {
  beforeEach(() => {
    vi.clearAllMocks(); clearVoiceModelMenuChoices();
    mocks.listUnifiedModelCatalog.mockResolvedValue([sttModel]);
    mocks.getDefaultCapabilityModel.mockReturnValue({ providerID: "groq", modelID: "whisper" });
    mocks.getCurrentTopicCapabilityOverride.mockReturnValue(undefined);
    mocks.getCurrentTopicSettings.mockReturnValue({ model: { providerID: "gemini", modelID: "audio" } });
  });

  it("explains Auto as Primary native then Main Default", async () => {
    const view = await buildVoiceModelSettingsView(context("settings:voice_model"));
    expect(view.text).toContain("Auto · Primary native");
    expect(view.text).toContain("Main Default STT helper");
  });

  it("stores an explicit Topic override and can reset to Auto", async () => {
    const view = await buildVoiceModelSettingsView(context("settings:voice_model"));
    const pick = callbacks(view).find((value) => typeof value === "string" && value.startsWith("settings:voice_model:pick:")) as string;
    await handleVoiceModelSettingsCallback(context(pick), pick);
    expect(mocks.setCurrentTopicCapabilityOverride).toHaveBeenCalledWith("speechToText", { providerID: "groq", modelID: "whisper" });

    mocks.getCurrentTopicCapabilityOverride.mockReturnValue({ providerID: "groq", modelID: "whisper" });
    await handleVoiceModelSettingsCallback(context("settings:voice_model:reset"), "settings:voice_model:reset");
    expect(mocks.setCurrentTopicCapabilityOverride).toHaveBeenCalledWith("speechToText", undefined);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getCurrentTopicSettings,
  getCurrentTopicImageModelOverride,
  getDefaultImageModel,
} = vi.hoisted(() => ({
  getCurrentTopicSettings: vi.fn(),
  getCurrentTopicImageModelOverride: vi.fn(),
  getDefaultImageModel: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/app/stores/settings-store.js")>(),
  getCurrentTopicSettings,
  getCurrentTopicImageModelOverride,
  getDefaultImageModel,
}));

import {
  buildDefaultModelsSettingsView,
  buildSettingsMenuView,
  buildTopicModelsSettingsView,
  SETTINGS_IMAGE_MODEL_CALLBACK,
  SETTINGS_TOPIC_MODELS_CALLBACK,
} from "../../../src/bot/menus/settings-menu.js";

function buttonTexts(view: { keyboard: import("grammy").InlineKeyboard }): string[] {
  return view.keyboard.inline_keyboard.flatMap((row) =>
    row.flatMap((button) =>
      "text" in button && typeof button.text === "string" ? [button.text] : []),
  );
}

function callbacks(view: { keyboard: import("grammy").InlineKeyboard }): string[] {
  return view.keyboard.inline_keyboard.flatMap((row) =>
    row.flatMap((button) =>
      "callback_data" in button && typeof button.callback_data === "string"
        ? [button.callback_data]
        : []),
  );
}

describe("Image AI Topic V2 model settings UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDefaultImageModel.mockReturnValue({
      providerID: "cloudflare",
      modelID: "flux",
    });
    getCurrentTopicImageModelOverride.mockReturnValue(undefined);
  });

  it("replaces legacy Image Chat defaults with the global Image Model entry", () => {
    getCurrentTopicSettings.mockReturnValue(undefined);
    const view = buildDefaultModelsSettingsView();

    expect(view.text).toContain("Image Model");
    expect(view.text).not.toContain("Auto free planner");
    expect(buttonTexts(view)).toContain("🎨 Image Model");
    expect(callbacks(view)).toContain(SETTINGS_IMAGE_MODEL_CALLBACK);
  });

  it("uses a Models hub in Topic Settings", () => {
    getCurrentTopicSettings.mockReturnValue({
      model: { providerID: "openai", modelID: "gpt-test" },
    });
    const view = buildSettingsMenuView();

    expect(buttonTexts(view)).toContain("🧠 Models");
    expect(callbacks(view)).toContain(SETTINGS_TOPIC_MODELS_CALLBACK);
    expect(view.text).toContain("Main Default");
  });

  it("shows both Chat/Coding and Image Model inside the Topic Models hub", () => {
    getCurrentTopicSettings.mockReturnValue({
      model: { providerID: "openai", modelID: "gpt-test" },
    });
    const view = buildTopicModelsSettingsView();

    expect(view.text).toContain("Chat / Coding");
    expect(view.text).toContain("Image Model");
    expect(callbacks(view)).toContain(SETTINGS_IMAGE_MODEL_CALLBACK);
  });
});

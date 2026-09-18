import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listImageAiProviders,
  getCurrentTopicSettings,
  getCurrentTopicImageModelOverride,
  getDefaultImageModel,
  setCurrentTopicImageModelOverride,
  setDefaultImageModel,
} = vi.hoisted(() => ({
  listImageAiProviders: vi.fn(),
  getCurrentTopicSettings: vi.fn(),
  getCurrentTopicImageModelOverride: vi.fn(),
  getDefaultImageModel: vi.fn(),
  setCurrentTopicImageModelOverride: vi.fn(),
  setDefaultImageModel: vi.fn(),
}));

vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({
  listImageAiProviders,
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentTopicSettings,
  getCurrentTopicImageModelOverride,
  getDefaultImageModel,
  setCurrentTopicImageModelOverride,
  setDefaultImageModel,
}));

import {
  buildImageModelSettingsView,
  clearImageModelMenuChoices,
  handleImageModelSettingsCallback,
} from "../../../src/bot/menus/image-model-menu.js";

function callbacks(
  view: Awaited<ReturnType<typeof buildImageModelSettingsView>>,
): string[] {
  return view.keyboard.inline_keyboard.flatMap((row) =>
    row.flatMap((button) =>
      "callback_data" in button && typeof button.callback_data === "string"
        ? [button.callback_data]
        : []),
  );
}

function context(data: string) {
  return {
    chat: { id: 123 },
    callbackQuery: {
      data,
      message: { message_id: 9, message_thread_id: 50, chat: { id: 123 } },
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("grammy").Context;
}

describe("Image Model V2 menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearImageModelMenuChoices();
    listImageAiProviders.mockResolvedValue([
      {
        id: "cloudflare",
        name: "Cloudflare",
        model: "flux-main",
        editModel: "flux-edit",
        capabilities: ["generate", "edit"],
        active: true,
        default: true,
      },
      {
        id: "generate-only",
        name: "Generate only",
        model: "gen",
        capabilities: ["generate"],
        active: true,
        default: false,
      },
    ]);
    getDefaultImageModel.mockReturnValue({
      providerID: "cloudflare",
      modelID: "flux-main",
      editModelID: "flux-edit",
    });
    getCurrentTopicImageModelOverride.mockReturnValue(undefined);
  });

  it("shows the global default and only generator+editor connections", async () => {
    getCurrentTopicSettings.mockReturnValue(undefined);
    const view = await buildImageModelSettingsView(context("settings:image_model"));

    expect(view.text).toContain("Main Default");
    expect(view.text).toContain("Cloudflare · flux-main");
    expect(view.text).not.toContain("Generate only");
    expect(callbacks(view)).toContain("settings:default_models");
  });

  it("shows inherited Main Default and reset only when a Topic has an override", async () => {
    getCurrentTopicSettings.mockReturnValue({
      model: { providerID: "p", modelID: "m" },
    });
    let view = await buildImageModelSettingsView(context("settings:image_model"));
    expect(view.text).toContain("Source · Main Default");
    expect(callbacks(view)).not.toContain("settings:image_model:reset");

    getCurrentTopicImageModelOverride.mockReturnValue({
      providerID: "cloudflare",
      modelID: "flux-main",
      editModelID: "flux-edit",
    });
    view = await buildImageModelSettingsView(context("settings:image_model"));
    expect(view.text).toContain("Source · Topic Override");
    expect(callbacks(view)).toContain("settings:image_model:reset");
  });

  it("stores a Topic override from a bounded callback token", async () => {
    getCurrentTopicSettings.mockReturnValue({
      model: { providerID: "p", modelID: "m" },
    });
    const view = await buildImageModelSettingsView(context("settings:image_model"));
    const pick = callbacks(view).find((value) =>
      value.startsWith("settings:image_model:pick:"));
    expect(pick).toBeDefined();

    await handleImageModelSettingsCallback(context(pick!), pick!);

    expect(setCurrentTopicImageModelOverride).toHaveBeenCalledWith({
      providerID: "cloudflare",
      modelID: "flux-main",
      editModelID: "flux-edit",
    });
    expect(setDefaultImageModel).not.toHaveBeenCalled();
  });

  it("resets a Topic override to dynamic Main Default inheritance", async () => {
    getCurrentTopicSettings.mockReturnValue({
      model: { providerID: "p", modelID: "m" },
    });

    await handleImageModelSettingsCallback(
      context("settings:image_model:reset"),
      "settings:image_model:reset",
    );

    expect(setCurrentTopicImageModelOverride).toHaveBeenCalledWith(undefined);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listImageModelCatalog,
  getCurrentTopicSettings,
  getCurrentTopicImageModelOverride,
  getDefaultImageModel,
  setCurrentTopicImageModelOverride,
  setDefaultImageModel,
} = vi.hoisted(() => ({
  listImageModelCatalog: vi.fn(),
  getCurrentTopicSettings: vi.fn(),
  getCurrentTopicImageModelOverride: vi.fn(),
  getDefaultImageModel: vi.fn(),
  setCurrentTopicImageModelOverride: vi.fn(),
  setDefaultImageModel: vi.fn(),
}));

vi.mock("../../../src/app/services/image-model-catalog-service.js", () => ({
  listImageModelCatalog,
  imageCatalogSelection: (entry: any) => ({
    providerID: entry.providerID,
    modelID: entry.modelID,
    ...(entry.editModelID ? { editModelID: entry.editModelID } : {}),
  }),
  catalogEntryMatchesSelection: (entry: any, selection: any) =>
    entry.providerID === selection.providerID
      && entry.modelID === selection.modelID
      && (entry.editModelID ?? entry.modelID) === (selection.editModelID ?? selection.modelID),
}));vi.mock("../../../src/app/stores/settings-store.js", () => ({
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
}describe("Image Model V2 menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearImageModelMenuChoices();
    listImageModelCatalog.mockResolvedValue([
      {
        providerID: "custom-images",
        providerName: "Custom Images",
        modelID: "image-a",
        modelName: "Image A",
        editModelID: "image-a",
        capabilities: ["generate", "edit"],
        source: "custom-provider",
      },
      {
        providerID: "custom-images",
        providerName: "Custom Images",
        modelID: "image-b",
        modelName: "Image B",
        editModelID: "image-b",
        capabilities: ["generate", "edit"],
        source: "custom-provider",
      },
      {
        providerID: "generate-only",
        providerName: "Generate only",
        modelID: "gen",
        modelName: "Gen",
        capabilities: ["generate"],
        source: "custom-provider",
      },
    ]);
    getDefaultImageModel.mockReturnValue({
      providerID: "custom-images",
      modelID: "image-a",
      editModelID: "image-a",
    });
    getCurrentTopicImageModelOverride.mockReturnValue(undefined);
  });  it("shows every selectable model discovered from an image provider", async () => {
    getCurrentTopicSettings.mockReturnValue(undefined);
    const view = await buildImageModelSettingsView(context("settings:image_model"));

    expect(view.text).toContain("Main Default");
    const labels = view.keyboard.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain("✅ Custom Images · Image A");
    expect(labels).toContain("🎨 Custom Images · Image B");
    expect(labels).not.toContain("🎨 Generate only · Gen");
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
      providerID: "custom-images",
      modelID: "image-b",
      editModelID: "image-b",
    });
    view = await buildImageModelSettingsView(context("settings:image_model"));
    expect(view.text).toContain("Source · Topic Override");
    expect(callbacks(view)).toContain("settings:image_model:reset");
  });  it("stores a Topic override from a bounded callback token", async () => {
    getCurrentTopicSettings.mockReturnValue({
      model: { providerID: "p", modelID: "m" },
    });
    const view = await buildImageModelSettingsView(context("settings:image_model"));
    const picks = callbacks(view).filter((value) =>
      value.startsWith("settings:image_model:pick:"));
    expect(picks).toHaveLength(2);

    await handleImageModelSettingsCallback(context(picks[1]!), picks[1]!);

    expect(setCurrentTopicImageModelOverride).toHaveBeenCalledWith({
      providerID: "custom-images",
      modelID: "image-b",
      editModelID: "image-b",
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
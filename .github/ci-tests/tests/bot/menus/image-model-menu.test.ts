import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listImageModelCatalog: vi.fn(),
  getCurrentTopicSettings: vi.fn(),
  getCurrentTopicImageModelOverride: vi.fn(),
  getDefaultImageModel: vi.fn(),
  getFreeModelDetectionEnabled: vi.fn(),
  setCurrentTopicImageModelOverride: vi.fn(),
  setDefaultImageModel: vi.fn(),
  getProviderModelPrices: vi.fn(),
  refreshModelCatalog: vi.fn(),
}));

vi.mock("../../../src/app/services/image-model-catalog-service.js", () => ({
  listImageModelCatalog: mocks.listImageModelCatalog,
  imageCatalogSelection: (entry: any) => ({
    providerID: entry.providerID,
    modelID: entry.modelID,
    ...(entry.editModelID ? { editModelID: entry.editModelID } : {}),
  }),
  catalogEntryMatchesSelection: (entry: any, selection: any) =>
    entry.providerID === selection.providerID
      && entry.modelID === selection.modelID
      && (entry.editModelID ?? entry.modelID) === (selection.editModelID ?? selection.modelID),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentTopicSettings: mocks.getCurrentTopicSettings,
  getCurrentTopicImageModelOverride: mocks.getCurrentTopicImageModelOverride,
  getDefaultImageModel: mocks.getDefaultImageModel,
  getFreeModelDetectionEnabled: mocks.getFreeModelDetectionEnabled,
  setCurrentTopicImageModelOverride: mocks.setCurrentTopicImageModelOverride,
  setDefaultImageModel: mocks.setDefaultImageModel,
}));

vi.mock("../../../src/app/services/model-price-service.js", () => ({
  getProviderModelPrices: mocks.getProviderModelPrices,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  refreshModelCatalog: mocks.refreshModelCatalog,
}));

import {
  buildImageModelSettingsView,
  clearImageModelMenuChoices,
  handleImageModelSettingsCallback,
} from "../../../src/bot/menus/image-model-menu.js";

function callbacks(view: Awaited<ReturnType<typeof buildImageModelSettingsView>>): string[] {
  return view.keyboard.inline_keyboard.flatMap((row) =>
    row.flatMap((button) =>
      "callback_data" in button && typeof button.callback_data === "string"
        ? [button.callback_data]
        : []),
  );
}

function labels(view: Awaited<ReturnType<typeof buildImageModelSettingsView>>): string[] {
  return view.keyboard.inline_keyboard.flat().map((button) => button.text);
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

const catalog = [
  {
    providerID: "mixed",
    providerName: "Mixed",
    modelID: "paid-edit",
    modelName: "Paid Edit",
    editModelID: "paid-edit",
    capabilities: ["generate", "edit"],
    source: "opencode-provider",
  },
  {
    providerID: "mixed",
    providerName: "Mixed",
    modelID: "free-generate",
    modelName: "Free Generate",
    capabilities: ["generate"],
    source: "opencode-provider",
  },
];

describe("Image Model V2 menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearImageModelMenuChoices();
    mocks.listImageModelCatalog.mockResolvedValue(catalog);
    mocks.getDefaultImageModel.mockReturnValue({
      providerID: "mixed",
      modelID: "paid-edit",
      editModelID: "paid-edit",
    });
    mocks.getCurrentTopicImageModelOverride.mockReturnValue(undefined);
    mocks.getCurrentTopicSettings.mockReturnValue(undefined);
    mocks.getFreeModelDetectionEnabled.mockReturnValue(false);
    mocks.refreshModelCatalog.mockResolvedValue(undefined);
    mocks.getProviderModelPrices.mockResolvedValue(new Map());
  });

  it("lists generation-only and edit-capable image models", async () => {
    const view = await buildImageModelSettingsView(context("settings:image_model"));
    expect(labels(view)).toContain("🎨 Mixed · Paid Edit ✓");
    expect(labels(view)).toContain("🎨 Mixed · Free Generate");
    expect(callbacks(view)).toContain("settings:default_models");
    expect(callbacks(view)).toContain("provider:connections");
  });

  it("reuses Experimental Free Model Detection as annotation only without reordering", async () => {
    mocks.getFreeModelDetectionEnabled.mockReturnValue(true);
    mocks.getProviderModelPrices.mockResolvedValue(new Map([
      ["paid-edit", { group: "paid", reason: "paid" }],
      ["free-generate", { group: "free", reason: "zero pricing" }],
    ]));

    const view = await buildImageModelSettingsView(context("settings:image_model"));
    const imageLabels = labels(view).filter((label) => label.includes("Mixed ·"));
    expect(imageLabels[0]).toBe("🧪 Paid? · 🎨 Mixed · Paid Edit ✓");
    expect(imageLabels[1]).toBe("🧪 Free? · 🎨 Mixed · Free Generate");
    expect(mocks.refreshModelCatalog).toHaveBeenCalledTimes(1);
  });

  it("shows Main Default inheritance and reset only for a Topic override", async () => {
    mocks.getCurrentTopicSettings.mockReturnValue({
      model: { providerID: "p", modelID: "m" },
    });
    let view = await buildImageModelSettingsView(context("settings:image_model"));
    expect(view.text).toContain("Source · Main Default");
    expect(callbacks(view)).not.toContain("settings:image_model:reset");

    mocks.getCurrentTopicImageModelOverride.mockReturnValue({
      providerID: "mixed",
      modelID: "free-generate",
    });
    view = await buildImageModelSettingsView(context("settings:image_model"));
    expect(view.text).toContain("Source · Topic Override");
    expect(callbacks(view)).toContain("settings:image_model:reset");
  });

  it("stores the selected Topic override", async () => {
    mocks.getCurrentTopicSettings.mockReturnValue({
      model: { providerID: "p", modelID: "m" },
    });
    const view = await buildImageModelSettingsView(context("settings:image_model"));
    const picks = callbacks(view).filter((value) =>
      value.startsWith("settings:image_model:pick:"));
    expect(picks).toHaveLength(2);

    await handleImageModelSettingsCallback(context(picks[1]!), picks[1]!);

    expect(mocks.setCurrentTopicImageModelOverride).toHaveBeenCalledWith({
      providerID: "mixed",
      modelID: "free-generate",
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getEffectiveImageModel,
  listImageModelCatalog,
  runImageForSelection,
  resolvePersistedImageModel,
} = vi.hoisted(() => ({
  getEffectiveImageModel: vi.fn(),
  listImageModelCatalog: vi.fn(),
  runImageForSelection: vi.fn(),
  resolvePersistedImageModel: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getEffectiveImageModel,
}));
vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({
  runImageForSelection,
}));
vi.mock("../../../src/app/services/image-model-resolution-service.js", () => ({
  resolvePersistedImageModel,
}));
vi.mock("../../../src/app/services/image-model-catalog-service.js", () => ({
  listImageModelCatalog,
  catalogEntryMatchesSelection: (entry: any, selection: any) =>
    entry.providerID === selection.providerID
      && entry.modelID === selection.modelID
      && (entry.editModelID ?? entry.modelID) === (selection.editModelID ?? selection.modelID),
}));

import {
  editConfiguredImage,
  generateConfiguredImage,
  resolveConfiguredImageModel,
} from "../../../src/app/services/image-action-service.js";

const selection = {
  providerID: "custom-images",
  modelID: "image-v2",
  editModelID: "image-v2",
};

const catalogEntry = {
  providerID: "custom-images",
  providerName: "Custom Images",
  modelID: "image-v2",
  modelName: "Image V2",
  editModelID: "image-v2",
  capabilities: ["generate", "edit"],
  source: "opencode-provider",
};

describe("image-action-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEffectiveImageModel.mockReturnValue(selection);
    resolvePersistedImageModel.mockResolvedValue(selection);
    listImageModelCatalog.mockResolvedValue([catalogEntry]);
    runImageForSelection.mockResolvedValue({
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    });
  });

  it("requires an explicitly configured Image Model", async () => {
    getEffectiveImageModel.mockReturnValue(undefined);
    resolvePersistedImageModel.mockResolvedValue(undefined);
    await expect(resolveConfiguredImageModel("generate")).rejects.toThrow(
      "Image Model is not configured",
    );
    expect(runImageForSelection).not.toHaveBeenCalled();
  });

  it("never falls back when the selected catalog entry is unavailable", async () => {
    listImageModelCatalog.mockResolvedValue([
      { ...catalogEntry, providerID: "other-provider", modelID: "other-model" },
    ]);
    await expect(resolveConfiguredImageModel("generate")).rejects.toThrow(
      "selected Image Model is unavailable",
    );
    expect(runImageForSelection).not.toHaveBeenCalled();
  });

  it("generates with the exact effective selection and worktree", async () => {
    const controller = new AbortController();
    await generateConfiguredImage("draw a lighthouse", controller.signal, "/work/topic");

    expect(runImageForSelection).toHaveBeenCalledWith(
      selection,
      "draw a lighthouse",
      undefined,
      controller.signal,
      "/work/topic",
    );
  });

  it("edits with the exact effective selection and worktree", async () => {
    const controller = new AbortController();
    const source = {
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    };

    await editConfiguredImage("make the sky warmer", source, controller.signal, "/work/topic");

    expect(runImageForSelection).toHaveBeenCalledWith(
      selection,
      "make the sky warmer",
      source,
      controller.signal,
      "/work/topic",
    );
  });

  it("rejects invalid image bytes before invoking the provider", async () => {
    await expect(editConfiguredImage(
      "edit it",
      { buffer: Buffer.from("not-an-image"), mimeType: "image/png" },
    )).rejects.toThrow("Only valid PNG, JPEG and WebP images");

    expect(runImageForSelection).not.toHaveBeenCalled();
  });
});
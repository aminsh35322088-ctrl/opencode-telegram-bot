import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getEffectiveImageModel,
  listImageAiProviders,
  runImageForSelection,
} = vi.hoisted(() => ({
  getEffectiveImageModel: vi.fn(),
  listImageAiProviders: vi.fn(),
  runImageForSelection: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getEffectiveImageModel,
}));
vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({
  listImageAiProviders,
  runImageForSelection,
}));

import {
  editConfiguredImage,
  generateConfiguredImage,
  resolveConfiguredImageModel,
} from "../../../src/app/services/image-action-service.js";

const selection = {
  providerID: "cloudflare",
  modelID: "flux-main",
  editModelID: "flux-edit",
};

const provider = {
  id: "cloudflare",
  name: "Cloudflare",
  model: "flux-main",
  editModel: "flux-edit",
  capabilities: ["generate", "edit"],
  active: true,
  default: false,
};

describe("image-action-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEffectiveImageModel.mockReturnValue(selection);
    listImageAiProviders.mockResolvedValue([provider]);
    runImageForSelection.mockResolvedValue({
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    });
  });

  it("requires an explicitly configured Image Model", async () => {
    getEffectiveImageModel.mockReturnValue(undefined);

    await expect(resolveConfiguredImageModel("generate")).rejects.toThrow(
      "Image Model is not configured",
    );
    expect(runImageForSelection).not.toHaveBeenCalled();
  });

  it("never falls back to another provider when the selected model is unavailable", async () => {
    listImageAiProviders.mockResolvedValue([
      {
        ...provider,
        id: "custom-image-ai",
        name: "Other provider",
      },
    ]);

    await expect(resolveConfiguredImageModel("generate")).rejects.toThrow(
      "selected Image Model is unavailable",
    );
    expect(runImageForSelection).not.toHaveBeenCalled();
  });

  it("generates with the exact effective Image Model selection", async () => {
    const controller = new AbortController();
    await generateConfiguredImage("draw a lighthouse", controller.signal);

    expect(runImageForSelection).toHaveBeenCalledWith(
      selection,
      "draw a lighthouse",
      undefined,
      controller.signal,
    );
  });

  it("edits a validated reference image with the exact effective selection", async () => {
    const controller = new AbortController();
    const source = {
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    };

    await editConfiguredImage("make the sky warmer", source, controller.signal);

    expect(runImageForSelection).toHaveBeenCalledWith(
      selection,
      "make the sky warmer",
      source,
      controller.signal,
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

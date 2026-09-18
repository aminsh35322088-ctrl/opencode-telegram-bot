import { beforeEach, describe, expect, it, vi } from "vitest";

const { listImageModelCatalog, runImageForSelection, resolveCapabilityRoute } = vi.hoisted(() => ({
  listImageModelCatalog: vi.fn(),
  runImageForSelection: vi.fn(),
  resolveCapabilityRoute: vi.fn(),
}));

vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({ runImageForSelection }));
vi.mock("../../../src/app/services/model-capability-routing-service.js", () => ({ resolveCapabilityRoute }));
vi.mock("../../../src/app/services/image-model-catalog-service.js", () => ({
  listImageModelCatalog,
  imageCatalogSelection: (entry: any) => ({ providerID: entry.providerID, modelID: entry.modelID, ...(entry.editModelID ? { editModelID: entry.editModelID } : {}) }),
}));

import { editConfiguredImage, generateConfiguredImage, resolveConfiguredImageModel } from "../../../src/app/services/image-action-service.js";

const selection = { providerID: "custom-images", modelID: "image-v2", editModelID: "image-v2" };
const catalogEntry = { providerID: "custom-images", providerName: "Custom Images", modelID: "image-v2", modelName: "Image V2", editModelID: "image-v2", capabilities: ["generate", "edit"], source: "unified-model-catalog" };

describe("image-action-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCapabilityRoute.mockResolvedValue({ capability: "imageGenerate", model: { providerID: "custom-images", modelID: "image-v2" }, routeSource: "main-default", primarySupportsCapability: false });
    listImageModelCatalog.mockResolvedValue([catalogEntry]);
    runImageForSelection.mockResolvedValue({ buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png" });
  });

  it("fails explicitly when routing cannot satisfy Image AI", async () => {
    resolveCapabilityRoute.mockResolvedValueOnce({ capability: "imageGenerate", routeSource: "unavailable", primarySupportsCapability: false, reason: "No capable model is configured." });
    await expect(resolveConfiguredImageModel("generate")).rejects.toThrow("No capable model is configured");
    expect(runImageForSelection).not.toHaveBeenCalled();
  });

  it("never falls back when the routed catalog entry is unavailable", async () => {
    listImageModelCatalog.mockResolvedValue([{ ...catalogEntry, providerID: "other-provider" }]);
    await expect(resolveConfiguredImageModel("generate")).rejects.toThrow("routed Image AI model is unavailable");
  });

  it("generates with the exact routed selection and worktree", async () => {
    const controller = new AbortController();
    await generateConfiguredImage("draw a lighthouse", controller.signal, "/work/topic");
    expect(resolveCapabilityRoute).toHaveBeenCalledWith("imageGenerate", "/work/topic");
    expect(runImageForSelection).toHaveBeenCalledWith(selection, "draw a lighthouse", undefined, controller.signal, "/work/topic");
  });

  it("edits with the same Image AI binding when editing is supported", async () => {
    resolveCapabilityRoute.mockResolvedValueOnce({ capability: "imageEdit", model: { providerID: "custom-images", modelID: "image-v2" }, routeSource: "main-default", primarySupportsCapability: false });
    const controller = new AbortController();
    const source = { buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png" };
    await editConfiguredImage("make the sky warmer", source, controller.signal, "/work/topic");
    expect(resolveCapabilityRoute).toHaveBeenCalledWith("imageEdit", "/work/topic");
    expect(runImageForSelection).toHaveBeenCalledWith(selection, "make the sky warmer", source, controller.signal, "/work/topic");
  });

  it("rejects invalid image bytes before invoking the provider", async () => {
    await expect(editConfiguredImage("edit it", { buffer: Buffer.from("not-an-image"), mimeType: "image/png" })).rejects.toThrow("Only valid PNG, JPEG and WebP images");
    expect(runImageForSelection).not.toHaveBeenCalled();
  });
});

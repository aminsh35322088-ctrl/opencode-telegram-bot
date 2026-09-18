import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listCustomProvidersByCapability,
  listImageAiProviders,
} = vi.hoisted(() => ({
  listCustomProvidersByCapability: vi.fn(),
  listImageAiProviders: vi.fn(),
}));

vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  listCustomProvidersByCapability,
}));
vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({
  listImageAiProviders,
}));

import {
  imageCatalogSelection,
  listImageModelCatalog,
} from "../../../src/app/services/image-model-catalog-service.js";

describe("image model catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();    listCustomProvidersByCapability.mockResolvedValue([
      {
        id: "my-images",
        name: "My Images",
        capability: "image",
        models: [
          { id: "image-a", name: "Image A" },
          { id: "image-b", name: "Image B" },
        ],
      },
    ]);
    listImageAiProviders.mockResolvedValue([
      {
        id: "cloudflare",
        name: "Cloudflare Workers AI",
        model: "@cf/example",
        capabilities: ["generate", "edit"],
        active: true,
        default: false,
      },
    ]);
  });

  it("flattens discovered custom image models plus built-in adapters", async () => {
    const catalog = await listImageModelCatalog();
    expect(catalog.map((entry) => [entry.providerID, entry.modelID])).toEqual([      ["cloudflare", "@cf/example"],
      ["my-images", "image-a"],
      ["my-images", "image-b"],
    ]);
  });

  it("uses one selected custom image model for generate and edit by default", async () => {
    const catalog = await listImageModelCatalog();
    const entry = catalog.find((item) =>
      item.providerID === "my-images" && item.modelID === "image-b");
    expect(entry).toBeDefined();
    expect(imageCatalogSelection(entry!)).toEqual({
      providerID: "my-images",
      modelID: "image-b",
      editModelID: "image-b",
    });
  });
});
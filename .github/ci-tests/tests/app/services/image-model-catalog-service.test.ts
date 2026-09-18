import { beforeEach, describe, expect, it, vi } from "vitest";

const { providers, listImageAiProviders } = vi.hoisted(() => ({
  providers: vi.fn(),
  listImageAiProviders: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    config: { providers },
  },
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
    vi.clearAllMocks();
    providers.mockResolvedValue({
      data: {
        providers: [
          {
            id: "mixed",
            name: "Mixed Provider",
            models: {
              "chat-only": {
                name: "Chat Only",
                capabilities: {
                  input: { text: true },
                  output: { text: true },
                },
              },
              "image-generate": {
                name: "Image Generate",
                capabilities: {
                  input: { text: true, image: false },
                  output: { image: true },
                },
              },
              "image-edit": {
                name: "Image Edit",
                capabilities: {
                  input: { text: true, image: true },
                  output: { image: true },
                },
              },
              unknown: { name: "Unknown" },
            },
          },
        ],
      },
      error: null,
    });
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

  it("detects image-output models across OpenCode providers and legacy adapters", async () => {
    const catalog = await listImageModelCatalog();
    expect(catalog.map((entry) => [entry.providerID, entry.modelID, entry.capabilities])).toEqual([
      ["cloudflare", "@cf/example", ["generate", "edit"]],
      ["mixed", "image-edit", ["generate", "edit"]],
      ["mixed", "image-generate", ["generate"]],
    ]);
  });

  it("does not guess image capability when provider metadata is missing", async () => {
    const catalog = await listImageModelCatalog();
    expect(catalog.some((entry) => entry.modelID === "unknown")).toBe(false);
    expect(catalog.some((entry) => entry.modelID === "chat-only")).toBe(false);
  });

  it("stores editModelID only for models that accept image input", async () => {
    const catalog = await listImageModelCatalog();
    const generate = catalog.find((entry) => entry.modelID === "image-generate");
    const edit = catalog.find((entry) => entry.modelID === "image-edit");

    expect(imageCatalogSelection(generate!)).toEqual({
      providerID: "mixed",
      modelID: "image-generate",
    });
    expect(imageCatalogSelection(edit!)).toEqual({
      providerID: "mixed",
      modelID: "image-edit",
      editModelID: "image-edit",
    });
  });
});
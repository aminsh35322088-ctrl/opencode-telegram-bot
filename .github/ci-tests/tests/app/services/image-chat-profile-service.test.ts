import { describe, expect, it } from "vitest";
import { rankAutoImageChatModels } from "../../../../src/app/services/image-chat-profile-service.js";
import { OPENROUTER_PROVIDER_ID } from "../../../../src/app/services/openrouter-provider-service.js";
import type { CustomProvider } from "../../../../src/app/services/custom-provider-service.js";

function openRouter(models: CustomProvider["models"]): CustomProvider {
  return {
    id: OPENROUTER_PROVIDER_ID,
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    capability: "coding",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    models,
  };
}
function vision(id: string) {
  return { id, name: id, attachment: true, modalities: { input: ["text", "image"], output: ["text"] } };
}

describe("image-chat-profile-service auto ranking", () => {
  it("prefers GPT, then Gemini, then DeepSeek regardless of catalog order", () => {
    const ranked = rankAutoImageChatModels([openRouter([
      vision("deepseek/deepseek-v3:free"),
      vision("google/gemini-2.5-flash:free"),
      vision("openai/gpt-oss-120b:free"),
    ])]);

    expect(ranked.map((model) => model.modelID)).toEqual([
      "openai/gpt-oss-120b:free",
      "google/gemini-2.5-flash:free",
      "deepseek/deepseek-v3:free",
    ]);
  });

  it("never includes paid or unconfirmed custom-provider models", () => {
    const ranked = rankAutoImageChatModels([
      openRouter([vision("openai/gpt-paid"), vision("google/gemini-free:free")]),
      {
        ...openRouter([vision("openai/custom-free-looking:free")]),
        id: "custom-provider",
        name: "Custom Provider",
      },
    ]);

    expect(ranked.map((model) => model.modelID)).toEqual(["google/gemini-free:free"]);
  });

  it("keeps OpenRouter free router as the capability-aware fallback", () => {
    const ranked = rankAutoImageChatModels([openRouter([
      vision("openrouter/free"),
      vision("meta-llama/llama-vision:free"),
    ])]);

    expect(ranked.map((model) => model.modelID)).toEqual([
      "meta-llama/llama-vision:free",
      "openrouter/free",
    ]);
    expect(ranked.at(-1)?.family).toBe("OpenRouter Free Router");
  });
});

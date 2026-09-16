import { describe, expect, it } from "vitest";
import { rankAutoImageChatModels } from "../../../src/app/services/image-chat-profile-service.js";
import type { CustomProvider } from "../../../src/app/services/custom-provider-service.js";

function provider(id: string, models: CustomProvider["models"], capability: CustomProvider["capability"] = "coding"): CustomProvider {
  return {
    id,
    name: id,
    baseURL: `https://${id}.test/v1`,
    capability,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    models,
  };
}
function vision(id: string) {
  return { id, name: id, attachment: true, modalities: { input: ["text", "image"], output: ["text"] } };
}

describe("image-chat-profile-service auto ranking", () => {
  it("prefers GPT, then Gemini, then DeepSeek regardless of provider or catalog order", () => {
    const ranked = rankAutoImageChatModels([
      provider("gateway-b", [vision("deepseek/deepseek-v3:free")]),
      provider("gateway-a", [vision("google/gemini-2.5-flash:free"), vision("openai/gpt-oss-120b:free")]),
    ]);

    expect(ranked.map((model) => model.modelID)).toEqual([
      "openai/gpt-oss-120b:free",
      "google/gemini-2.5-flash:free",
      "deepseek/deepseek-v3:free",
    ]);
  });

  it("accepts explicit :free vision models from custom coding providers only", () => {
    const ranked = rankAutoImageChatModels([
      provider("custom-a", [vision("qwen/qwen3-vl:free"), vision("openai/gpt-paid")]),
      provider("custom-stt", [vision("google/gemini-vision:free")], "stt"),
      provider("custom-b", [{ id: "deepseek/text-only:free", name: "Text only", modalities: { input: ["text"], output: ["text"] } }]),
    ]);

    expect(ranked).toEqual([{
      providerID: "custom-a",
      modelID: "qwen/qwen3-vl:free",
      family: "Qwen",
    }]);
  });

  it("puts unknown explicit free model families after known families", () => {
    const ranked = rankAutoImageChatModels([provider("custom", [
      vision("vendor/vision:free"),
      vision("meta-llama/llama-vision:free"),
    ])]);

    expect(ranked.map((model) => model.modelID)).toEqual([
      "meta-llama/llama-vision:free",
      "vendor/vision:free",
    ]);
    expect(ranked.at(-1)?.family).toBe("Other free model");
  });
});
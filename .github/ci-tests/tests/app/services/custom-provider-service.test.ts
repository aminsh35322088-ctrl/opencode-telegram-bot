import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOpenCodeCustomModelConfig,
  normalizeDiscoveredModel,
  probeToolCallSupport,
} from "../../../src/app/services/custom-provider-service.js";

describe("custom-provider model capability normalization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("preserves standard modalities exposed by a provider", () => {
    const model = normalizeDiscoveredModel({
      id: "vision-model",
      name: "Vision Model",
      modalities: { input: ["text", "image"], output: ["text"] },
    });

    expect(model).toEqual({
      id: "vision-model",
      name: "Vision Model",
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    });
  });

  it("accepts OpenRouter-style architecture modality metadata", () => {
    const model = normalizeDiscoveredModel({
      id: "provider/model",
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
    });

    expect(model?.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    expect(model?.attachment).toBe(true);
  });

  it("preserves an explicit text-only declaration", () => {
    const model = normalizeDiscoveredModel({
      id: "text-model",
      modalities: { input: ["text"], output: ["text"] },
    });

    expect(getOpenCodeCustomModelConfig(model!)).toEqual({
      name: "text-model",
      attachment: false,
      tool_call: false,
      modalities: { input: ["text"], output: ["text"] },
    });
  });

  it("uses a generic multimodal fallback when /models exposes no modality metadata", () => {
    const model = normalizeDiscoveredModel({ id: "unknown-model" });

    expect(model).toEqual({ id: "unknown-model", name: "unknown-model" });
    expect(getOpenCodeCustomModelConfig(model!)).toEqual({
      name: "unknown-model",
      attachment: true,
      tool_call: false,
      modalities: { input: ["text", "image"], output: ["text"] },
    });
  });

  it("only enables OpenCode tool calling after a live verification", () => {
    const model = {
      id: "agent-model",
      name: "Agent Model",
      toolCall: true,
      toolCallVerified: true,
      modalities: { input: ["text"], output: ["text"] },
    };

    expect(getOpenCodeCustomModelConfig(model)).toMatchObject({ tool_call: true });
  });

  it("preserves provider tool-call hints without treating them as verified", () => {
    const model = normalizeDiscoveredModel({
      id: "hinted-model",
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
    });

    expect(model?.toolCall).toBe(true);
    expect(model?.toolCallVerified).toBeUndefined();
    expect(getOpenCodeCustomModelConfig(model!)).toMatchObject({ tool_call: false });
  });

  it("verifies a real OpenAI-compatible tool call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              type: "function",
              function: { name: "opencode_action_probe", arguments: JSON.stringify({ ping: "ok" }) },
            }],
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      probeToolCallSupport("https://provider.example/v1", "secret", "agent-model"),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a model that answers but ignores every required tool-call strategy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "plain text" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      probeToolCallSupport("https://provider.example/v1", "secret", "text-only"),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not recognize unsupported arbitrary modality names", () => {
    const model = normalizeDiscoveredModel({
      id: "mixed-model",
      modalities: { input: ["text", "image", "unknown-type"], output: ["text"] },
    });

    expect(model?.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
  });
});

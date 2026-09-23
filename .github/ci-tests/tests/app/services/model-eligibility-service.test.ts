import { describe, expect, it } from "vitest";
import {
  isAgentToolCapableModelMetadata,
  isChatModelMetadata,
  isImageEditModelMetadata,
  isImageModelMetadata,
} from "../../../src/app/services/model-eligibility-service.js";

describe("model-level capability classification", () => {
  it("requires explicit tool calling for agent-mode chat/coding", () => {
    expect(
      isAgentToolCapableModelMetadata({
        modalities: { output: ["text"] },
        toolCall: true,
      }),
    ).toBe(true);

    expect(
      isAgentToolCapableModelMetadata({
        modalities: { output: ["text"] },
        toolCall: false,
      }),
    ).toBe(false);

    expect(isAgentToolCapableModelMetadata({ id: "unknown-tools" })).toBe(false);
  });
  it("keeps unknown legacy metadata chat-compatible without guessing image output", () => {
    const metadata = { id: "legacy-model" };
    expect(isChatModelMetadata(metadata)).toBe(true);
    expect(isImageModelMetadata(metadata)).toBe(false);
    expect(isImageEditModelMetadata(metadata)).toBe(false);
  });

  it("detects image generation from explicit OpenCode output capabilities", () => {
    const metadata = {
      capabilities: {
        input: { text: true, image: false },
        output: { text: false, image: true },
      },
    };
    expect(isChatModelMetadata(metadata)).toBe(false);
    expect(isImageModelMetadata(metadata)).toBe(true);
    expect(isImageEditModelMetadata(metadata)).toBe(false);
  });

  it("detects editing only when image input and output are both advertised", () => {
    const metadata = {
      modalities: {
        input: ["text", "image"],
        output: ["image"],
      },
    };
    expect(isImageModelMetadata(metadata)).toBe(true);
    expect(isImageEditModelMetadata(metadata)).toBe(true);
  });

  it("keeps mixed text+image output in both Chat/Coding and Image views", () => {
    const metadata = {
      capabilities: {
        output: { text: true, image: true },
      },
    };
    expect(isChatModelMetadata(metadata)).toBe(true);
    expect(isImageModelMetadata(metadata)).toBe(true);
  });
});

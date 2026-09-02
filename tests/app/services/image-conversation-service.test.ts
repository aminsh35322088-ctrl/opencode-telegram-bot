import { afterEach, describe, expect, it } from "vitest";
import {
  __resetImageConversationStateForTests,
  activateImageConversation,
  clearImageConversation,
  isImageConversationActive,
  setCurrentImage,
} from "../../../src/app/services/image-conversation-service.js";

describe("image-conversation-service", () => {
  afterEach(() => {
    __resetImageConversationStateForTests();
  });

  it("keeps conversation activation isolated per chat", () => {
    activateImageConversation(100);

    expect(isImageConversationActive(100)).toBe(true);
    expect(isImageConversationActive(200)).toBe(false);
  });

  it("clears only the requested chat conversation", () => {
    activateImageConversation(100);
    activateImageConversation(200);

    clearImageConversation(100);

    expect(isImageConversationActive(100)).toBe(false);
    expect(isImageConversationActive(200)).toBe(true);
  });

  it("can store a current image without activating another chat", () => {
    activateImageConversation(100);
    const image = { buffer: Buffer.from("image"), mimeType: "image/png" };

    setCurrentImage(100, image);

    expect(isImageConversationActive(100)).toBe(true);
    expect(isImageConversationActive(200)).toBe(false);
  });
});

import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import { flushImageConversationStore } from "../../../src/app/stores/image-conversation-store.js";
import {
  __resetImageConversationStateForTests,
  activateImageConversation,
  clearImageConversation,
  getConversationHistory,
  isImageConversationActive,
  setCurrentImage,
} from "../../../src/app/services/image-conversation-service.js";

describe("image-conversation-service", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-image-conversation-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    await __resetImageConversationStateForTests();
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await __resetImageConversationStateForTests();
    await rm(tempHome, { recursive: true, force: true });
  });

  it("keeps conversation activation isolated per chat", async () => {
    await activateImageConversation(100);

    expect(await isImageConversationActive(100)).toBe(true);
    expect(await isImageConversationActive(200)).toBe(false);
  });

  it("clears only the requested chat conversation", async () => {
    await activateImageConversation(100);
    await activateImageConversation(200);

    await clearImageConversation(100);

    expect(await isImageConversationActive(100)).toBe(false);
    expect(await isImageConversationActive(200)).toBe(true);
  });

  it("can store a current image without activating another chat", async () => {
    await activateImageConversation(100);
    const image = { buffer: Buffer.from("image"), mimeType: "image/png" };

    await setCurrentImage(100, image);

    expect(await isImageConversationActive(100)).toBe(true);
    expect(await isImageConversationActive(200)).toBe(false);
  });

  it("persists conversation state to disk for recovery after restart", async () => {
    await activateImageConversation(100);
    await setCurrentImage(100, { buffer: Buffer.from("hello-image"), mimeType: "image/png" });
    await flushImageConversationStore();

    const storePath = path.join(tempHome, "image-conversations.json");
    const persisted = JSON.parse(await readFile(storePath, "utf8"));
    const state = persisted.conversations["100"];

    expect(state).toBeDefined();
    expect(state.currentImageMimeType).toBe("image/png");
    expect(Buffer.from(state.currentImageBase64, "base64").toString()).toBe("hello-image");
  });

  it("keeps the in-memory state in sync after writes", async () => {
    await activateImageConversation(100);
    await setCurrentImage(100, { buffer: Buffer.from("x"), mimeType: "image/png" });

    expect(await isImageConversationActive(100)).toBe(true);
    expect(await getConversationHistory(100)).toEqual([]);
  });
});

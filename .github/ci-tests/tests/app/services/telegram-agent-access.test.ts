import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  findNode: vi.fn(), findTopic: vi.fn(), getContext: vi.fn(), generate: vi.fn(), resolveImage: vi.fn(),
}));
vi.mock("../../../src/control-plane/node-bindings.js", () => ({ nodeBindings: { find: mocked.findNode } }));
vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({ findTelegramTopicBindingByThread: mocked.findTopic }));
vi.mock("../../../src/app/services/telegram-message-context-service.js", () => ({ getTelegramMessageContext: mocked.getContext }));
vi.mock("../../../src/app/services/image-action-service.js", () => ({ generateConfiguredImage: mocked.generate, editConfiguredImage: vi.fn() }));
vi.mock("../../../src/app/services/image-model-resolution-service.js", () => ({ resolvePersistedImageModel: mocked.resolveImage }));

import { runTelegramAgentAccess, resetTelegramAgentAccessForTests } from "../../../src/app/services/telegram-agent-access.js";

const owner = { nodeId: "node_1", generation: 3, chatId: -100123, threadId: 44, sessionId: "ses_topic" };

describe("Topic-scoped Telegram media capability", () => {
  beforeEach(async () => {
    await resetTelegramAgentAccessForTests();
    vi.clearAllMocks();
    mocked.findNode.mockResolvedValue({ status: "ready", nodeId: owner.nodeId, generation: owner.generation, sessionId: owner.sessionId });
    mocked.findTopic.mockResolvedValue({ chatId: owner.chatId, threadId: owner.threadId, sessionId: owner.sessionId, directory: "/workspace/topic" });
    mocked.getContext.mockResolvedValue({ chatId: owner.chatId, threadId: owner.threadId, sessionId: owner.sessionId, worktree: "/workspace/topic", updatedAt: new Date().toISOString(), message: { messageId: 99, media: [] } });
    mocked.generate.mockResolvedValue({ buffer: Buffer.from("fake-png-bytes"), mimeType: "image/png" });
    mocked.resolveImage.mockResolvedValue({ providerID: "image-provider", modelID: "image-model" });
  });

  it("generates through the configured Image AI service and streams bytes only to its owning Topic", async () => {
    const result = await runTelegramAgentAccess({ action: "image.generate", prompt: "a small orange cat" }, owner) as { transferId: string; filename: string; mimeType: string; size: number; selection: unknown };
    expect(result).toMatchObject({ filename: expect.stringMatching(/^image-\d+\.png$/), mimeType: "image/png", size: Buffer.byteLength("fake-png-bytes"), selection: { providerID: "image-provider", modelID: "image-model" } });
    expect(mocked.generate).toHaveBeenCalledWith("a small orange cat", expect.any(AbortSignal), "/workspace/topic", { sessionId: owner.sessionId, directory: "/workspace/topic" });

    const chunk = await runTelegramAgentAccess({ action: "media.chunk", transferId: result.transferId, offset: 0, limit: 128 }, owner) as { data: string; eof: boolean; size: number };
    expect(Buffer.from(chunk.data, "base64")).toEqual(Buffer.from("fake-png-bytes"));
    expect(chunk).toMatchObject({ eof: true, size: Buffer.byteLength("fake-png-bytes") });
    await runTelegramAgentAccess({ action: "media.finish", transferId: result.transferId }, owner);
    await expect(runTelegramAgentAccess({ action: "media.chunk", transferId: result.transferId, offset: 0, limit: 128 }, owner)).rejects.toThrow(/expired or belongs to another Topic/);
  });

  it("rejects media reads from a stale Worker generation before accessing files", async () => {
    mocked.findNode.mockResolvedValue({ status: "ready", nodeId: owner.nodeId, generation: owner.generation + 1, sessionId: owner.sessionId });
    await expect(runTelegramAgentAccess({ action: "image.generate", prompt: "cat" }, owner)).rejects.toThrow(/binding changed/);
    expect(mocked.generate).not.toHaveBeenCalled();
  });
});

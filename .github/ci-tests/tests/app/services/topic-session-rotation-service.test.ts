import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  deleteSession: vi.fn(),
  getTopicRuntimeState: vi.fn(),
  updateTopicRuntimeState: vi.fn(),
  updateTelegramTopicBinding: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      create: mocks.create,
      delete: mocks.deleteSession,
    },
  },
}));
vi.mock("../../../src/app/stores/topic-runtime-state-store.js", () => ({
  getTopicRuntimeState: mocks.getTopicRuntimeState,
  updateTopicRuntimeState: mocks.updateTopicRuntimeState,
}));
vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({
  updateTelegramTopicBinding: mocks.updateTelegramTopicBinding,
}));

import { rotateTelegramTopicSessionForModel } from "../../../src/app/services/topic-session-rotation-service.js";

const binding = {
  bindingId: "100:20",
  bindingGeneration: 1,
  chatId: 100,
  threadId: 20,
  sessionId: "ses_old",
  directory: "/workspace/topic",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  title: "Chat #01",
};
const oldModel = { providerID: "provider-a", modelID: "old", name: "Old" };
const newModel = { providerID: "provider-b", modelID: "new", name: "New" };
const oldRuntime = {
  chatId: 100,
  threadId: 20,
  updatedAt: "2026-09-15T00:00:00.000Z",
  settings: {
    session: { id: "ses_old", title: "Chat #01", directory: "/workspace/topic" },
    workspaceDirectory: "/workspace/topic",
    model: oldModel,
    runState: "idle",
    compactOutputMode: false,
    showThinkingContent: true,
    responseStreamingMode: "edit",
    messageFormatMode: "markdown",
    showAssistantRunFooter: true,
    sendDiffFileAttachments: true,
    promptQueueEnabled: false,
    updatedAt: "2026-09-15T00:00:00.000Z",
  },
};

describe("Topic session rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTopicRuntimeState.mockResolvedValue(oldRuntime);
    mocks.create.mockResolvedValue({ data: { id: "ses_new", title: "Fresh session" } });
    mocks.updateTelegramTopicBinding.mockResolvedValue(undefined);
    mocks.updateTopicRuntimeState.mockResolvedValue(oldRuntime);
    mocks.deleteSession.mockResolvedValue({ data: true });
  });

  it("creates a fresh model-pinned session and moves the Topic binding/runtime together", async () => {
    const result = await rotateTelegramTopicSessionForModel(binding, newModel);

    expect(result.previousSessionId).toBe("ses_old");
    expect(result.session).toEqual({ id: "ses_new", title: "Fresh session", directory: "/workspace/topic" });
    expect(mocks.create).toHaveBeenCalledWith({
      directory: "/workspace/topic",
      body: { model: { providerID: "provider-b", modelID: "new" } },
    });
    expect(mocks.updateTelegramTopicBinding).toHaveBeenCalledWith(100, 20, { sessionId: "ses_new" });
    expect(mocks.updateTopicRuntimeState).toHaveBeenCalledWith(100, 20, expect.objectContaining({
      session: { id: "ses_new", title: "Fresh session", directory: "/workspace/topic" },
      model: newModel,
      runState: "idle",
    }));
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it("rolls the binding back and removes the orphan replacement if runtime persistence fails", async () => {
    mocks.updateTopicRuntimeState
      .mockRejectedValueOnce(new Error("runtime write failed"))
      .mockResolvedValueOnce(oldRuntime);

    await expect(rotateTelegramTopicSessionForModel(binding, newModel)).rejects.toThrow("runtime write failed");

    expect(mocks.updateTelegramTopicBinding).toHaveBeenNthCalledWith(1, 100, 20, { sessionId: "ses_new" });
    expect(mocks.updateTelegramTopicBinding).toHaveBeenNthCalledWith(2, 100, 20, { sessionId: "ses_old" });
    expect(mocks.updateTopicRuntimeState).toHaveBeenLastCalledWith(100, 20, oldRuntime.settings);
    expect(mocks.deleteSession).toHaveBeenCalledWith({ sessionID: "ses_new", directory: "/workspace/topic" });
  });
});

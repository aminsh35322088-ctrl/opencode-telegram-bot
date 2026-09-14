import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";

const mocks = vi.hoisted(() => ({
  sessionDeleteMock: vi.fn(),
  isTelegramTopicWorkspaceMock: vi.fn(() => true),
  deleteTelegramTopicWorkspaceMock: vi.fn(async () => {}),
  removeTelegramTopicBindingMock: vi.fn(async () => {}),
  listTelegramTopicBindingsMock: vi.fn(async () => [] as unknown[]),
  removeTopicRuntimeStateMock: vi.fn(async () => {}),
  stopTopicEventSubscriptionMock: vi.fn(),
  retireSessionRuntimeMock: vi.fn(),
  clearSessionQueueMock: vi.fn(),
  clearSessionAttachmentMock: vi.fn(),
  clearSessionKeyboardMock: vi.fn(),
  initializeKeyboardMock: vi.fn(),
  sendKeyboardUpdateMock: vi.fn(async () => {}),
  clearInteractionMock: vi.fn(),
  getCurrentSessionMock: vi.fn(() => undefined),
  clearSessionServiceMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { delete: mocks.sessionDeleteMock } },
}));
vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: mocks.getCurrentSessionMock,
  clearSession: mocks.clearSessionServiceMock,
}));
vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({
  removeTelegramTopicBinding: mocks.removeTelegramTopicBindingMock,
  listTelegramTopicBindings: mocks.listTelegramTopicBindingsMock,
}));
vi.mock("../../../src/app/services/telegram-topic-workspace-service.js", () => ({
  isTelegramTopicWorkspace: mocks.isTelegramTopicWorkspaceMock,
  deleteTelegramTopicWorkspace: mocks.deleteTelegramTopicWorkspaceMock,
}));
vi.mock("../../../src/app/stores/topic-runtime-state-store.js", () => ({
  removeTopicRuntimeState: mocks.removeTopicRuntimeStateMock,
}));
vi.mock("../../../src/app/managers/prompt-queue-manager.js", () => ({
  promptQueue: { clearSession: mocks.clearSessionQueueMock },
}));
vi.mock("../../../src/app/managers/prompt-attachment-manager.js", () => ({
  promptAttachment: { clearSession: mocks.clearSessionAttachmentMock },
}));
vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    clearSession: mocks.clearSessionKeyboardMock,
    initialize: mocks.initializeKeyboardMock,
    sendKeyboardUpdate: mocks.sendKeyboardUpdateMock,
  },
}));
vi.mock("../../../src/app/managers/interaction-manager.js", () => ({
  interactionManager: { clearSession: mocks.clearInteractionMock },
}));
vi.mock("../../../src/opencode/events.js", () => ({
  stopTopicEventSubscription: mocks.stopTopicEventSubscriptionMock,
}));
vi.mock("../../../src/bot/services/telegram-topic-runtime.js", () => ({
  getTelegramTopicRuntimeDependencies: () => ({ retireSessionRuntime: mocks.retireSessionRuntimeMock }),
}));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { deleteTelegramTopicSession } from "../../../src/app/services/telegram-topic-delete-service.js";

function createBinding(directory: string) {
  return {
    chatId: 5,
    threadId: 7,
    sessionId: "ses_test",
    directory,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("telegram-topic-delete-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTelegramTopicWorkspaceMock.mockReturnValue(true);
    mocks.sessionDeleteMock.mockResolvedValue({ data: true, error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes local cleanup even when the Telegram topic deletion keeps failing", async () => {
    const api = {
      deleteForumTopic: vi.fn().mockRejectedValue(new Error("Bad Request: chat not found")),
    } as unknown as Api;
    const binding = createBinding("/ws/5/ses_test");

    await expect(deleteTelegramTopicSession(api, binding)).rejects.toThrow();

    // Destructive-but-safe local steps must have run despite the Telegram error.
    expect(mocks.deleteTelegramTopicWorkspaceMock).toHaveBeenCalledWith(binding.directory);
    expect(mocks.removeTopicRuntimeStateMock).toHaveBeenCalledWith(5, 7);
    expect(mocks.removeTelegramTopicBindingMock).toHaveBeenCalledWith(5, "ses_test");
    expect(mocks.stopTopicEventSubscriptionMock).toHaveBeenCalledWith(binding.directory, "ses_test");
  });

  it("removes binding and runtime state even when the directory is unmanaged", async () => {
    mocks.isTelegramTopicWorkspaceMock.mockReturnValue(false);
    const api = { deleteForumTopic: vi.fn().mockResolvedValue(true) } as unknown as Api;
    const binding = createBinding("/outside/managed/root");

    await expect(deleteTelegramTopicSession(api, binding)).rejects.toThrow(/cleanup step/);

    // The filesystem rm is refused, but state cleanup still converges.
    expect(mocks.deleteTelegramTopicWorkspaceMock).not.toHaveBeenCalled();
    expect(mocks.removeTelegramTopicBindingMock).toHaveBeenCalledWith(5, "ses_test");
    expect(mocks.removeTopicRuntimeStateMock).toHaveBeenCalledWith(5, 7);
  });

  it("deletes workspace, session, and binding on the happy path without throwing", async () => {
    const api = { deleteForumTopic: vi.fn().mockResolvedValue(true) } as unknown as Api;
    const binding = createBinding("/ws/5/ses_test");

    await deleteTelegramTopicSession(api, binding);

    expect(mocks.sessionDeleteMock).toHaveBeenCalledWith({ sessionID: "ses_test", directory: "/ws/5/ses_test" });
    expect(mocks.deleteTelegramTopicWorkspaceMock).toHaveBeenCalledWith("/ws/5/ses_test");
    expect(mocks.removeTelegramTopicBindingMock).toHaveBeenCalledWith(5, "ses_test");
    expect(mocks.retireSessionRuntimeMock).toHaveBeenCalledWith("ses_test", "topic_deleted");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { startCommand } from "../../../src/bot/commands/start-command.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  abortCurrentOperationMock: vi.fn(),
  clearSessionMock: vi.fn(),
  clearProjectMock: vi.fn(),
  createMainKeyboardMock: vi.fn(() => ({ keyboard: true })),
  getStoredAgentMock: vi.fn(() => "build"),
  getStoredModelMock: vi.fn(() => ({
    providerID: "openai",
    modelID: "gpt-5",
    variant: "default",
  })),
  formatVariantForButtonMock: vi.fn(() => "Default"),
  pinnedIsInitializedMock: vi.fn(() => false),
  pinnedInitializeMock: vi.fn(),
  pinnedGetContextLimitMock: vi.fn(() => 0),
  pinnedRefreshContextLimitMock: vi.fn().mockResolvedValue(undefined),
  pinnedGetContextInfoMock: vi.fn(() => null),
  pinnedClearMock: vi.fn().mockResolvedValue(undefined),
  keyboardInitializeMock: vi.fn(),
  keyboardUpdateAgentMock: vi.fn(),
  keyboardUpdateModelMock: vi.fn(),
  keyboardUpdateContextMock: vi.fn(),
  keyboardClearContextMock: vi.fn(),
  getMainTelegramTopicMock: vi.fn(),
  saveMainTelegramTopicMock: vi.fn().mockResolvedValue(undefined),
  findTelegramTopicBindingByThreadMock: vi.fn(),
  createForumTopicMock: vi.fn(),
  editForumTopicMock: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/bot/commands/abort-command.js", () => ({
  abortCurrentOperation: mocked.abortCurrentOperationMock,
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  clearSession: mocked.clearSessionMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  clearProject: mocked.clearProjectMock,
}));

vi.mock("../../../src/bot/keyboards/main-reply-keyboard.js", () => ({
  createMainKeyboard: mocked.createMainKeyboardMock,
}));

vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: mocked.getStoredAgentMock,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: mocked.getStoredModelMock,
}));

vi.mock("../../../src/app/services/variant-selection-service.js", () => ({
  formatVariantForButton: mocked.formatVariantForButtonMock,
}));

vi.mock("../../../src/app/services/telegram-main-topic-store.js", () => ({
  getMainTelegramTopic: mocked.getMainTelegramTopicMock,
  saveMainTelegramTopic: mocked.saveMainTelegramTopicMock,
}));

vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({
  findTelegramTopicBindingByThread: mocked.findTelegramTopicBindingByThreadMock,
}));

vi.mock("../../../src/bot/pinned/pinned-message-manager.js", () => ({
  pinnedMessageManager: {
    isInitialized: mocked.pinnedIsInitializedMock,
    initialize: mocked.pinnedInitializeMock,
    getContextLimit: mocked.pinnedGetContextLimitMock,
    refreshContextLimit: mocked.pinnedRefreshContextLimitMock,
    getContextInfo: mocked.pinnedGetContextInfoMock,
    clear: mocked.pinnedClearMock,
  },
}));

vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    initialize: mocked.keyboardInitializeMock,
    updateAgent: mocked.keyboardUpdateAgentMock,
    updateModel: mocked.keyboardUpdateModelMock,
    updateContext: mocked.keyboardUpdateContextMock,
    clearContext: mocked.keyboardClearContextMock,
    setPaused: vi.fn(),
  },
}));

function createStartContext(threadId?: number): Context {
  const raw = {
    createForumTopic: mocked.createForumTopicMock,
    editForumTopic: mocked.editForumTopicMock,
  };
  return {
    chat: { id: 100 },
    message: threadId ? { message_thread_id: threadId } : undefined,
    api: { raw, sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Context;
}

describe("bot/commands/start-command", () => {
  beforeEach(() => {
    mocked.abortCurrentOperationMock.mockReset();
    mocked.abortCurrentOperationMock.mockResolvedValue(undefined);

    mocked.clearSessionMock.mockReset();
    mocked.clearProjectMock.mockReset();

    mocked.createMainKeyboardMock.mockReset();
    mocked.createMainKeyboardMock.mockReturnValue({ keyboard: true });

    mocked.getStoredAgentMock.mockReset();
    mocked.getStoredAgentMock.mockReturnValue("build");

    mocked.getStoredModelMock.mockReset();
    mocked.getStoredModelMock.mockReturnValue({
      providerID: "openai",
      modelID: "gpt-5",
      variant: "default",
    });

    mocked.formatVariantForButtonMock.mockReset();
    mocked.formatVariantForButtonMock.mockReturnValue("Default");

    mocked.pinnedIsInitializedMock.mockReset();
    mocked.pinnedIsInitializedMock.mockReturnValue(false);
    mocked.pinnedInitializeMock.mockReset();
    mocked.pinnedGetContextLimitMock.mockReset();
    mocked.pinnedGetContextLimitMock.mockReturnValue(0);
    mocked.pinnedRefreshContextLimitMock.mockReset();
    mocked.pinnedRefreshContextLimitMock.mockResolvedValue(undefined);
    mocked.pinnedGetContextInfoMock.mockReset();
    mocked.pinnedGetContextInfoMock.mockReturnValue(null);
    mocked.pinnedClearMock.mockReset();
    mocked.pinnedClearMock.mockResolvedValue(undefined);

    mocked.keyboardInitializeMock.mockReset();
    mocked.keyboardUpdateAgentMock.mockReset();
    mocked.keyboardUpdateModelMock.mockReset();
    mocked.keyboardUpdateContextMock.mockReset();
    mocked.keyboardClearContextMock.mockReset();

    mocked.getMainTelegramTopicMock.mockReset();
    mocked.getMainTelegramTopicMock.mockResolvedValue(null);
    mocked.saveMainTelegramTopicMock.mockReset();
    mocked.saveMainTelegramTopicMock.mockResolvedValue(undefined);
    mocked.findTelegramTopicBindingByThreadMock.mockReset();
    mocked.findTelegramTopicBindingByThreadMock.mockResolvedValue(null);
    mocked.createForumTopicMock.mockReset();
    mocked.createForumTopicMock.mockResolvedValue({ message_thread_id: 999 });
    mocked.editForumTopicMock.mockReset();
    mocked.editForumTopicMock.mockResolvedValue(true);
  });

  it("stops active flow, resets project/session, and sends welcome message", async () => {
    const ctx = createStartContext();

    await startCommand(ctx);

    expect(mocked.abortCurrentOperationMock).toHaveBeenCalledWith(ctx, { notifyUser: false });
    expect(mocked.clearSessionMock).toHaveBeenCalledTimes(1);
    expect(mocked.clearProjectMock).toHaveBeenCalledTimes(1);
    expect(mocked.keyboardClearContextMock).toHaveBeenCalledTimes(1);
    expect(mocked.pinnedClearMock).toHaveBeenCalledTimes(1);
    expect(mocked.pinnedInitializeMock).toHaveBeenCalledWith(ctx.api, 100);
    expect(mocked.keyboardInitializeMock).toHaveBeenCalledWith(ctx.api, 100);
    expect(mocked.pinnedRefreshContextLimitMock).toHaveBeenCalledTimes(1);

    expect(mocked.createForumTopicMock).toHaveBeenCalledWith({ chat_id: 100, name: "General" });
    expect(mocked.saveMainTelegramTopicMock).toHaveBeenCalledWith(100, 999, "General");
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ message_thread_id: 999 }));
  });

  it("renames and adopts the exact Telegram-created /start topic instead of creating another topic", async () => {
    const ctx = createStartContext(731925);

    await startCommand(ctx);

    expect(mocked.findTelegramTopicBindingByThreadMock).toHaveBeenCalledWith(100, 731925);
    expect(mocked.editForumTopicMock).toHaveBeenCalledWith({
      chat_id: 100,
      message_thread_id: 731925,
      name: "General",
    });
    expect(mocked.saveMainTelegramTopicMock).toHaveBeenCalledWith(100, 731925, "General");
    expect(mocked.createForumTopicMock).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ message_thread_id: 731925 }));
  });
});

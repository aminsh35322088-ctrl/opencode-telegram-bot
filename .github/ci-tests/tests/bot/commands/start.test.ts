import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { startCommand } from "../../../src/bot/commands/start-command.js";

const mocked = vi.hoisted(() => ({
  abortCurrentOperationMock: vi.fn(),
  clearSessionMock: vi.fn(),
  clearProjectMock: vi.fn(),
  detachAttachedSessionMock: vi.fn(),
  clearPausedSessionMock: vi.fn(),
  foregroundClearAllMock: vi.fn(),
  assistantRunClearAllMock: vi.fn(),
  getBotUpdateNoticeMock: vi.fn().mockResolvedValue(null),
  markBotVersionNotifiedMock: vi.fn().mockResolvedValue(undefined),
  pinnedIsInitializedMock: vi.fn(() => false),
  pinnedInitializeMock: vi.fn(),
  pinnedGetContextLimitMock: vi.fn(() => 0),
  pinnedRefreshContextLimitMock: vi.fn().mockResolvedValue(undefined),
  pinnedClearMock: vi.fn().mockResolvedValue(undefined),
  keyboardInitializeMock: vi.fn(),
  keyboardClearContextMock: vi.fn(),
  keyboardSetPausedMock: vi.fn(),
  keyboardIsTopicModeMock: vi.fn(() => false),
  replaceMainInlineKeyboardMock: vi.fn().mockResolvedValue(true),
  sendMainInlineKeyboardMock: vi.fn().mockResolvedValue(undefined),
  findTelegramTopicBindingByThreadMock: vi.fn(),
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

vi.mock("../../../src/app/services/attach-service.js", () => ({
  detachAttachedSession: mocked.detachAttachedSessionMock,
}));

vi.mock("../../../src/app/managers/paused-session-manager.js", () => ({
  clearPausedSession: mocked.clearPausedSessionMock,
}));

vi.mock("../../../src/app/managers/foreground-session-state-manager.js", () => ({
  foregroundSessionState: { clearAll: mocked.foregroundClearAllMock },
}));

vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({
  assistantRunState: { clearAll: mocked.assistantRunClearAllMock },
}));

vi.mock("../../../src/app/services/version-info-service.js", () => ({
  getBotUpdateNotice: mocked.getBotUpdateNoticeMock,
  markBotVersionNotified: mocked.markBotVersionNotifiedMock,
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
    clear: mocked.pinnedClearMock,
  },
}));

vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    initialize: mocked.keyboardInitializeMock,
    clearContext: mocked.keyboardClearContextMock,
    setPaused: mocked.keyboardSetPausedMock,
    isTopicMode: mocked.keyboardIsTopicModeMock,
    replaceMainInlineKeyboard: mocked.replaceMainInlineKeyboardMock,
    sendMainInlineKeyboard: mocked.sendMainInlineKeyboardMock,
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createStartContext(threadId?: number): Context {
  return {
    chat: { id: 100 },
    message: threadId ? { message_thread_id: threadId } : undefined,
    api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Context;
}

describe("bot/commands/start-command", () => {
  beforeEach(() => {
    mocked.abortCurrentOperationMock.mockReset().mockResolvedValue(undefined);
    mocked.clearSessionMock.mockReset();
    mocked.clearProjectMock.mockReset();
    mocked.detachAttachedSessionMock.mockReset();
    mocked.clearPausedSessionMock.mockReset();
    mocked.foregroundClearAllMock.mockReset();
    mocked.assistantRunClearAllMock.mockReset();
    mocked.getBotUpdateNoticeMock.mockReset().mockResolvedValue(null);
    mocked.markBotVersionNotifiedMock.mockReset().mockResolvedValue(undefined);
    mocked.pinnedIsInitializedMock.mockReset().mockReturnValue(false);
    mocked.pinnedInitializeMock.mockReset();
    mocked.pinnedGetContextLimitMock.mockReset().mockReturnValue(0);
    mocked.pinnedRefreshContextLimitMock.mockReset().mockResolvedValue(undefined);
    mocked.pinnedClearMock.mockReset().mockResolvedValue(undefined);
    mocked.keyboardInitializeMock.mockReset();
    mocked.keyboardClearContextMock.mockReset();
    mocked.keyboardSetPausedMock.mockReset();
    mocked.keyboardIsTopicModeMock.mockReset().mockReturnValue(false);
    mocked.replaceMainInlineKeyboardMock.mockReset().mockResolvedValue(true);
    mocked.sendMainInlineKeyboardMock.mockReset().mockResolvedValue(undefined);
    mocked.findTelegramTopicBindingByThreadMock.mockReset().mockResolvedValue(null);
  });

  it("stops active flow, resets project/session, and replaces the root Main panel", async () => {
    const ctx = createStartContext();

    await startCommand(ctx);

    expect(mocked.abortCurrentOperationMock).toHaveBeenCalledWith(ctx, { notifyUser: false });
    expect(mocked.detachAttachedSessionMock).toHaveBeenCalledWith("start_command_reset");
    expect(mocked.foregroundClearAllMock).toHaveBeenCalledWith("start_command_reset");
    expect(mocked.assistantRunClearAllMock).toHaveBeenCalledWith("start_command_reset");
    expect(mocked.clearPausedSessionMock).toHaveBeenCalledTimes(1);
    expect(mocked.keyboardSetPausedMock).toHaveBeenCalledWith(false);
    expect(mocked.clearSessionMock).toHaveBeenCalledTimes(1);
    expect(mocked.clearProjectMock).toHaveBeenCalledTimes(1);
    expect(mocked.keyboardClearContextMock).toHaveBeenCalledTimes(1);
    expect(mocked.pinnedClearMock).toHaveBeenCalledTimes(1);
    expect(mocked.pinnedInitializeMock).toHaveBeenCalledWith(ctx.api, 100);
    expect(mocked.keyboardInitializeMock).toHaveBeenCalledWith(ctx.api, 100);
    expect(mocked.pinnedRefreshContextLimitMock).toHaveBeenCalledTimes(1);
    expect(mocked.replaceMainInlineKeyboardMock).toHaveBeenCalledWith(100);
    expect(mocked.sendMainInlineKeyboardMock).not.toHaveBeenCalled();
    // /start must never spawn Telegram topics on its own.
    expect(mocked.findTelegramTopicBindingByThreadMock).not.toHaveBeenCalled();
  });

  it("also replaces the root Main panel when topic mode is already active", async () => {
    mocked.keyboardIsTopicModeMock.mockReturnValue(true);
    const ctx = createStartContext();

    await startCommand(ctx);

    expect(mocked.replaceMainInlineKeyboardMock).toHaveBeenCalledWith(100);
    expect(mocked.sendMainInlineKeyboardMock).not.toHaveBeenCalled();
    expect(mocked.abortCurrentOperationMock).not.toHaveBeenCalled();
  });

  it("treats /start inside a Telegram Topic as navigation without replacing the root anchor", async () => {
    mocked.findTelegramTopicBindingByThreadMock.mockResolvedValue({
      chatId: 100,
      threadId: 731925,
      sessionId: "session-1",
    });
    const ctx = createStartContext(731925);

    await startCommand(ctx);

    expect(mocked.findTelegramTopicBindingByThreadMock).toHaveBeenCalledWith(100, 731925);
    expect(mocked.abortCurrentOperationMock).not.toHaveBeenCalled();
    expect(mocked.clearSessionMock).not.toHaveBeenCalled();
    expect(mocked.clearProjectMock).not.toHaveBeenCalled();
    expect(mocked.pinnedClearMock).not.toHaveBeenCalled();
    expect(mocked.replaceMainInlineKeyboardMock).not.toHaveBeenCalled();
    expect(mocked.sendMainInlineKeyboardMock).toHaveBeenCalledWith(100, undefined, true);
  });
});

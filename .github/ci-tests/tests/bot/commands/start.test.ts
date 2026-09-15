import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { startCommand } from "../../../src/bot/commands/start-command.js";

const MAIN_REPLY_MARKUP = { keyboard: [[{ text: "💬 New Chat" }]], is_persistent: true };
const MAIN_INLINE_MARKUP = { inline_keyboard: [[{ text: "💬 New Chat", callback_data: "main:new" }]] };
const STORED_MODEL = { providerID: "b-ai", modelID: "qwen3.8-flash", name: "Qwen 3.8 flash" };

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
  getStoredModelMock: vi.fn(),
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
  mainScopeReplyKeyboardMock: vi.fn(),
  setMainInlineMessageMock: vi.fn().mockResolvedValue(undefined),
  noteMainScopeKeyboardAppliedMock: vi.fn(),
  buildMainStatusTextMock: vi.fn().mockResolvedValue("MAIN STATUS"),
  createMainInlineKeyboardMock: vi.fn(),
  findTelegramTopicBindingByThreadMock: vi.fn(),
}));

vi.mock("../../../src/bot/commands/abort-command.js", () => ({
  abortCurrentOperation: mocked.abortCurrentOperationMock,
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  clearSession: mocked.clearSessionMock,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: mocked.getStoredModelMock,
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

vi.mock("../../../src/bot/keyboards/main-reply-keyboard.js", () => ({
  createMainInlineKeyboard: mocked.createMainInlineKeyboardMock,
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
  buildMainStatusText: mocked.buildMainStatusTextMock,
  keyboardManager: {
    initialize: mocked.keyboardInitializeMock,
    clearContext: mocked.keyboardClearContextMock,
    setPaused: mocked.keyboardSetPausedMock,
    isTopicMode: mocked.keyboardIsTopicModeMock,
    replaceMainInlineKeyboard: mocked.replaceMainInlineKeyboardMock,
    sendMainInlineKeyboard: mocked.sendMainInlineKeyboardMock,
    mainScopeReplyKeyboard: mocked.mainScopeReplyKeyboardMock,
    setMainInlineMessage: mocked.setMainInlineMessageMock,
    noteMainScopeKeyboardApplied: mocked.noteMainScopeKeyboardAppliedMock,
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createStartContext(threadId?: number): Context {
  return {
    chat: { id: 100 },
    message: threadId ? { message_thread_id: threadId } : undefined,
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      editMessageReplyMarkup: vi.fn().mockResolvedValue({ message_id: 1 }),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
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
    mocked.getStoredModelMock.mockReset().mockReturnValue(STORED_MODEL);
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
    mocked.mainScopeReplyKeyboardMock.mockReset().mockReturnValue(MAIN_REPLY_MARKUP);
    mocked.setMainInlineMessageMock.mockReset().mockResolvedValue(undefined);
    mocked.noteMainScopeKeyboardAppliedMock.mockReset();
    mocked.buildMainStatusTextMock.mockReset().mockResolvedValue("MAIN STATUS");
    mocked.createMainInlineKeyboardMock.mockReset().mockReturnValue(MAIN_INLINE_MARKUP);
    mocked.findTelegramTopicBindingByThreadMock.mockReset().mockResolvedValue(null);
  });

  it("stops active flow, resets project/session, and force-replaces the root Main reply keyboard", async () => {
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
    expect(mocked.getStoredModelMock).toHaveBeenCalledTimes(1);
    expect(mocked.buildMainStatusTextMock).toHaveBeenCalledWith(STORED_MODEL);
    expect(mocked.mainScopeReplyKeyboardMock).toHaveBeenCalledTimes(1);
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(100, "MAIN STATUS", {
      parse_mode: "HTML",
      reply_markup: MAIN_REPLY_MARKUP,
    });
    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(100, 1, {
      reply_markup: MAIN_INLINE_MARKUP,
    });
    expect(mocked.setMainInlineMessageMock).toHaveBeenCalledWith(100, 1);
    expect(mocked.noteMainScopeKeyboardAppliedMock).toHaveBeenCalledWith(100);
    expect(mocked.replaceMainInlineKeyboardMock).not.toHaveBeenCalled();
    expect(mocked.sendMainInlineKeyboardMock).not.toHaveBeenCalled();
    expect(mocked.findTelegramTopicBindingByThreadMock).not.toHaveBeenCalled();
  });

  it("force-replaces stale Topic reply controls when topic mode is already active", async () => {
    mocked.keyboardIsTopicModeMock.mockReturnValue(true);
    const ctx = createStartContext();

    await startCommand(ctx);

    expect(ctx.api.sendMessage).toHaveBeenCalledWith(100, "MAIN STATUS", {
      parse_mode: "HTML",
      reply_markup: MAIN_REPLY_MARKUP,
    });
    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(100, 1, {
      reply_markup: MAIN_INLINE_MARKUP,
    });
    expect(mocked.setMainInlineMessageMock).toHaveBeenCalledWith(100, 1);
    expect(mocked.noteMainScopeKeyboardAppliedMock).toHaveBeenCalledWith(100);
    expect(mocked.replaceMainInlineKeyboardMock).not.toHaveBeenCalled();
    expect(mocked.abortCurrentOperationMock).not.toHaveBeenCalled();
  });

  it("falls back to the last known-good Main replacement if Telegram cannot attach inline controls", async () => {
    const ctx = createStartContext();
    vi.mocked(ctx.api.editMessageReplyMarkup).mockRejectedValueOnce(new Error("edit failed"));

    await startCommand(ctx);

    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(100, 1);
    expect(mocked.setMainInlineMessageMock).not.toHaveBeenCalled();
    expect(mocked.replaceMainInlineKeyboardMock).toHaveBeenCalledWith(100);
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
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
  });
});

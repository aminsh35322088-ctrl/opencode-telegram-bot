import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCompactOutputMode: vi.fn(() => false),
  getMainNavigationMessageId: vi.fn(),
  setMainNavigationMessageId: vi.fn(),
  clearMainNavigationMessageId: vi.fn(),
  getStoredAgent: vi.fn(() => "code"),
  getStoredModel: vi.fn(() => ({ providerID: "p", modelID: "m", name: "Model" })),
  formatVariantForButton: vi.fn(() => "Default"),
  getTopicRuntimeStateSync: vi.fn(() => null),
  getTopicRuntimeContext: vi.fn(() => undefined),
  isChatPaused: vi.fn(() => false),
  hasActiveRun: vi.fn(() => false),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCompactOutputMode: mocks.getCompactOutputMode,
  getMainNavigationMessageId: mocks.getMainNavigationMessageId,
  setMainNavigationMessageId: mocks.setMainNavigationMessageId,
  clearMainNavigationMessageId: mocks.clearMainNavigationMessageId,
}));
vi.mock("../../../src/app/services/agent-selection-service.js", () => ({ getStoredAgent: mocks.getStoredAgent }));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({ getStoredModel: mocks.getStoredModel }));
vi.mock("../../../src/app/services/variant-selection-service.js", () => ({ formatVariantForButton: mocks.formatVariantForButton }));
vi.mock("../../../src/app/stores/topic-runtime-state-store.js", () => ({ getTopicRuntimeStateSync: mocks.getTopicRuntimeStateSync }));
vi.mock("../../../src/app/services/topic-runtime-context.js", () => ({ getTopicRuntimeContext: mocks.getTopicRuntimeContext }));
vi.mock("../../../src/app/managers/paused-session-manager.js", () => ({ isChatPaused: mocks.isChatPaused }));
vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({ assistantRunState: { hasActiveRun: mocks.hasActiveRun } }));
vi.mock("../../../src/app/services/version-info-service.js", () => ({ BOT_VERSION: "test", getOpenCodeVersion: vi.fn(async () => "test") }));
vi.mock("../../../src/app/types/model.js", () => ({ formatModelForDisplay: vi.fn((_provider: string, _model: string, name?: string) => name ?? "Model") }));
vi.mock("../../../src/bot/keyboards/queued-prompt-button.js", () => ({ getQueuedPromptButtonLabels: vi.fn(() => []) }));
vi.mock("../../../src/bot/keyboards/main-reply-keyboard.js", () => ({
  createMainInlineKeyboard: vi.fn(() => ({ inline_keyboard: [[{ text: "Main", callback_data: "main" }]] })),
  createMainKeyboard: vi.fn(() => ({ keyboard: [[{ text: "Main" }]] })),
  createTopicKeyboard: vi.fn(() => ({ keyboard: [[{ text: "Topic" }]] })),
}));
vi.mock("../../../src/bot/services/telegram-topic-runtime.js", () => ({ getUnscopedTelegramApi: (api: unknown) => api }));
vi.mock("../../../src/i18n/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/i18n/index.js")>();
  return { ...actual, t: (key: string) => key };
});
vi.mock("../../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { keyboardManager } from "../../../src/bot/keyboards/keyboard-manager.js";

describe("Main panel All/root pin isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMainNavigationMessageId.mockReturnValue(undefined);
    mocks.setMainNavigationMessageId.mockResolvedValue(undefined);
    mocks.clearMainNavigationMessageId.mockResolvedValue(undefined);
    mocks.getStoredModel.mockReturnValue({ providerID: "p", modelID: "m", name: "Model" });
    mocks.getStoredAgent.mockReturnValue("code");
    mocks.getTopicRuntimeStateSync.mockReturnValue(null);
    mocks.getTopicRuntimeContext.mockReturnValue(undefined);
    mocks.getCompactOutputMode.mockReturnValue(false);
    mocks.isChatPaused.mockReturnValue(false);
    mocks.hasActiveRun.mockReturnValue(false);
  });

  it("creates the Main panel outside Topics and pins exactly that root message", async () => {
    const chatId = 10101;
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 701 });
    const pinChatMessage = vi.fn().mockResolvedValue(true);
    const api = {
      sendMessage,
      pinChatMessage,
      editMessageText: vi.fn(),
      unpinChatMessage: vi.fn(),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };

    keyboardManager.initialize(api as never, chatId);
    await keyboardManager.sendMainInlineKeyboard(chatId, mocks.getStoredModel(), true);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , options] = sendMessage.mock.calls[0] as [number, string, Record<string, unknown>];
    expect(options).not.toHaveProperty("message_thread_id");
    expect(mocks.setMainNavigationMessageId).toHaveBeenCalledWith(chatId, 701);
    expect(pinChatMessage).toHaveBeenCalledTimes(1);
    expect(pinChatMessage).toHaveBeenCalledWith(chatId, 701, { disable_notification: true });
  });

  it("re-pins the canonical root message after an in-place refresh", async () => {
    const chatId = 10102;
    mocks.getMainNavigationMessageId.mockReturnValue(702);
    const sendMessage = vi.fn();
    const editMessageText = vi.fn().mockResolvedValue({});
    const pinChatMessage = vi.fn().mockResolvedValue(true);
    const api = {
      sendMessage,
      editMessageText,
      pinChatMessage,
      unpinChatMessage: vi.fn(),
      deleteMessage: vi.fn(),
    };

    keyboardManager.initialize(api as never, chatId);
    await keyboardManager.sendMainInlineKeyboard(chatId, mocks.getStoredModel(), true);

    expect(editMessageText).toHaveBeenCalledWith(chatId, 702, expect.any(String), expect.any(Object));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(pinChatMessage).toHaveBeenCalledWith(chatId, 702, { disable_notification: true });
  });

  it("transactionally replaces the previous root panel and moves the pin to the fresh panel", async () => {
    const chatId = 10105;
    mocks.getMainNavigationMessageId.mockReturnValue(705);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 706 });
    const pinChatMessage = vi.fn().mockResolvedValue(true);
    const unpinChatMessage = vi.fn().mockResolvedValue(true);
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const editMessageText = vi.fn();
    const api = { sendMessage, pinChatMessage, unpinChatMessage, deleteMessage, editMessageText };

    keyboardManager.initialize(api as never, chatId);
    const replaced = await keyboardManager.replaceMainInlineKeyboard(chatId, mocks.getStoredModel());

    expect(replaced).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , options] = sendMessage.mock.calls[0] as [number, string, Record<string, unknown>];
    expect(options).not.toHaveProperty("message_thread_id");
    expect(editMessageText).not.toHaveBeenCalled();
    expect(pinChatMessage).toHaveBeenCalledWith(chatId, 706, { disable_notification: true });
    expect(mocks.setMainNavigationMessageId).toHaveBeenCalledWith(chatId, 706);
    expect(unpinChatMessage).toHaveBeenCalledWith(chatId, 705);
    expect(deleteMessage).toHaveBeenCalledWith(chatId, 705);
    expect(pinChatMessage.mock.invocationCallOrder[0]).toBeLessThan(unpinChatMessage.mock.invocationCallOrder[0]);
  });

  it("keeps the previous canonical panel when the fresh /start panel cannot be pinned", async () => {
    const chatId = 10106;
    mocks.getMainNavigationMessageId.mockReturnValue(707);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 708 });
    const pinChatMessage = vi.fn()
      .mockRejectedValueOnce(new Error("pin failed"))
      .mockResolvedValueOnce(true);
    const unpinChatMessage = vi.fn().mockResolvedValue(true);
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const api = {
      sendMessage,
      pinChatMessage,
      editMessageText: vi.fn(),
      unpinChatMessage,
      deleteMessage,
    };

    keyboardManager.initialize(api as never, chatId);
    const replaced = await keyboardManager.replaceMainInlineKeyboard(chatId, mocks.getStoredModel());

    expect(replaced).toBe(false);
    expect(mocks.setMainNavigationMessageId).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(chatId, 708);
    expect(deleteMessage).not.toHaveBeenCalledWith(chatId, 707);
    expect(pinChatMessage).toHaveBeenNthCalledWith(2, chatId, 707, { disable_notification: true });
  });

  it("rejects a replacement candidate that leaks into a real Topic and leaves the old anchor alone", async () => {
    const chatId = 10107;
    mocks.getMainNavigationMessageId.mockReturnValue(709);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 710, message_thread_id: 88 });
    const pinChatMessage = vi.fn().mockResolvedValue(true);
    const unpinChatMessage = vi.fn();
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const api = {
      sendMessage,
      pinChatMessage,
      editMessageText: vi.fn(),
      unpinChatMessage,
      deleteMessage,
    };

    keyboardManager.initialize(api as never, chatId);
    const replaced = await keyboardManager.replaceMainInlineKeyboard(chatId, mocks.getStoredModel());

    expect(replaced).toBe(false);
    expect(deleteMessage).toHaveBeenCalledWith(chatId, 710);
    expect(deleteMessage).not.toHaveBeenCalledWith(chatId, 709);
    expect(mocks.setMainNavigationMessageId).not.toHaveBeenCalled();
    expect(pinChatMessage).not.toHaveBeenCalled();
    expect(unpinChatMessage).not.toHaveBeenCalled();
  });

  it("fails closed when a supposed Main message is returned inside a real Topic", async () => {
    const chatId = 10103;
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 703, message_thread_id: 42 });
    const pinChatMessage = vi.fn().mockResolvedValue(true);
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const api = {
      sendMessage,
      pinChatMessage,
      editMessageText: vi.fn(),
      unpinChatMessage: vi.fn(),
      deleteMessage,
    };

    keyboardManager.initialize(api as never, chatId);
    await keyboardManager.sendMainInlineKeyboard(chatId, mocks.getStoredModel(), true);

    expect(deleteMessage).toHaveBeenCalledWith(chatId, 703);
    expect(mocks.setMainNavigationMessageId).not.toHaveBeenCalled();
    expect(pinChatMessage).not.toHaveBeenCalled();
  });

  it("never pins when sending a coding Topic keyboard", async () => {
    const chatId = 10104;
    const threadId = 77;
    const sessionId = "topic-session-pin-isolation";
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 704, message_thread_id: threadId });
    const pinChatMessage = vi.fn().mockResolvedValue(true);
    const api = {
      sendMessage,
      pinChatMessage,
      editMessageText: vi.fn(),
      unpinChatMessage: vi.fn(),
      deleteMessage: vi.fn(),
    };

    keyboardManager.bindTopic(api as never, chatId, threadId, sessionId);
    await keyboardManager.sendKeyboardUpdate(chatId, true, sessionId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , options] = sendMessage.mock.calls[0] as [number, string, Record<string, unknown>];
    expect(options.message_thread_id).toBe(threadId);
    expect(pinChatMessage).not.toHaveBeenCalled();
  });
});

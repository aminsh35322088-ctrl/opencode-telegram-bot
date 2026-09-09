import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCompactOutputMode: vi.fn(),
  getStoredAgent: vi.fn(),
  getStoredModel: vi.fn(),
  formatVariantForButton: vi.fn(),
  getQueuedPromptButtonLabels: vi.fn(),
  isChatPaused: vi.fn(),
  assistantRunState: { hasActiveRun: vi.fn() },
  getMainTelegramThreadIdSync: vi.fn(),
  getTopicRuntimeStateSync: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({ getCompactOutputMode: mocks.getCompactOutputMode, setCompactOutputMode: vi.fn() }));
vi.mock("../../../src/app/services/agent-selection-service.js", () => ({ getStoredAgent: mocks.getStoredAgent }));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({ getStoredModel: mocks.getStoredModel }));
vi.mock("../../../src/app/services/variant-selection-service.js", () => ({ formatVariantForButton: mocks.formatVariantForButton }));
vi.mock("../../../src/bot/keyboards/queued-prompt-button.js", () => ({ getQueuedPromptButtonLabels: mocks.getQueuedPromptButtonLabels }));
vi.mock("../../../src/app/managers/paused-session-manager.js", () => ({ isChatPaused: mocks.isChatPaused }));
vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({ assistantRunState: mocks.assistantRunState }));
vi.mock("../../../src/app/services/telegram-main-topic-store.js", () => ({ getMainTelegramThreadIdSync: mocks.getMainTelegramThreadIdSync }));
vi.mock("../../../src/app/stores/topic-runtime-state-store.js", () => ({ getTopicRuntimeStateSync: mocks.getTopicRuntimeStateSync }));
vi.mock("../../../src/i18n/index.js", () => ({ t: (key: string) => key, normalizeLocale: vi.fn(() => "en") }));
vi.mock("../../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { keyboardManager } from "../../../src/bot/keyboards/keyboard-manager.js";
import { runInTopicRuntimeContext } from "../../../src/app/services/topic-runtime-context.js";

const CHAT_ID = -1001234567890;
const THREAD_ID = 42;
const SESSION_ID = "sess-scope-1";

function keyboardTexts(keyboard: unknown): string[] {
  const rows = (keyboard as { keyboard?: Array<Array<{ text?: string }>> }).keyboard ?? [];
  return rows.flat().map((button) => button?.text ?? "");
}

describe("bot/keyboards/keyboard-manager scope resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStoredModel.mockReturnValue({ providerID: "p", modelID: "m", name: "Global Model" });
    mocks.getStoredAgent.mockReturnValue("code");
    mocks.formatVariantForButton.mockReturnValue("Default");
    mocks.getQueuedPromptButtonLabels.mockReturnValue([]);
    mocks.isChatPaused.mockReturnValue(false);
    mocks.assistantRunState.hasActiveRun.mockReturnValue(false);
    mocks.getMainTelegramThreadIdSync.mockReturnValue(null);
    mocks.getTopicRuntimeStateSync.mockReturnValue(null);
    mocks.getCompactOutputMode.mockReturnValue(false);
  });

  it("bindTopic outside any runtime context still seeds the Topic's own persisted model, not the ambient default", () => {
    mocks.getStoredModel.mockReturnValue({ providerID: "p", modelID: "global-default", name: "Global Default" });
    mocks.getTopicRuntimeStateSync.mockReturnValue({
      settings: { model: { providerID: "p2", modelID: "topicone" } },
    });

    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, "session-topic-model");
    const texts = keyboardTexts(keyboardManager.getKeyboard("session-topic-model"));

    expect(mocks.getTopicRuntimeStateSync).toHaveBeenCalledWith(CHAT_ID, THREAD_ID);
    expect(texts.some((text) => text.includes("topicone"))).toBe(true);
    expect(texts.some((text) => text.includes("Global Default"))).toBe(false);
  });

  it("re-syncs a stale keyboard state to the Topic's persisted model on the next bind", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, "session-resync");
    mocks.getTopicRuntimeStateSync.mockReturnValue({
      settings: { model: { providerID: "p3", modelID: "persisted-model", name: "Persisted" } },
    });

    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, "session-resync");
    const texts = keyboardTexts(keyboardManager.getKeyboard("session-resync"));

    expect(texts.some((text) => text.includes("Persisted"))).toBe(true);
    expect(texts.some((text) => text.includes("Global Model"))).toBe(false);
  });

  it("returns the Main keyboard when no topic runtime context is active", () => {
    keyboardManager.initialize({} as never, CHAT_ID);
    const keyboard = keyboardManager.getKeyboard();
    const texts = keyboardTexts(keyboard);
    expect(texts).toContain("💬 New Chat");
    expect(texts).not.toContain("🧠 Model Center");
  });

  it("returns the Topic keyboard when called inside the topic runtime context", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, SESSION_ID);
    const keyboard = runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.getKeyboard());
    const texts = keyboardTexts(keyboard);
    expect(texts).toContain("🧠 Model Center");
    expect(texts).not.toContain("💬 New Chat");
    expect(texts).not.toContain("⏸️ Pause");
    expect(texts).not.toContain("▶️ Resume");
    expect(texts).not.toContain("🛑 Abort");
  });

  it("shows execution controls only while the Topic session is actively running", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, SESSION_ID);
    mocks.assistantRunState.hasActiveRun.mockReturnValue(true);
    const runningKeyboard = keyboardManager.getKeyboard(SESSION_ID);
    const runningTexts = keyboardTexts(runningKeyboard);
    expect(runningTexts).toContain("⏸️ Pause");
    expect(runningTexts).toContain("🛑 Abort");

    mocks.assistantRunState.hasActiveRun.mockReturnValue(false);
    const idleKeyboard = keyboardManager.getKeyboard(SESSION_ID);
    const idleTexts = keyboardTexts(idleKeyboard);
    expect(idleTexts).not.toContain("⏸️ Pause");
    expect(idleTexts).not.toContain("▶️ Resume");
    expect(idleTexts).not.toContain("🛑 Abort");
  });

  it("uses Resume and Abort for a paused Topic run", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, SESSION_ID);
    mocks.isChatPaused.mockReturnValue(true);
    mocks.assistantRunState.hasActiveRun.mockReturnValue(false);
    const keyboard = keyboardManager.getKeyboard(SESSION_ID);
    const texts = keyboardTexts(keyboard);
    expect(texts).toContain("▶️ Resume");
    expect(texts).toContain("🛑 Abort");
    expect(texts).not.toContain("⏸️ Pause");
  });

  it("sendKeyboardUpdate inside a topic runtime context sends the topic keyboard to the topic thread", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    keyboardManager.bindTopic({ sendMessage } as never, CHAT_ID, THREAD_ID, SESSION_ID);
    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, true));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , options] = sendMessage.mock.calls[0] as [number, string, Record<string, unknown>];
    expect(options.message_thread_id).toBe(THREAD_ID);
    expect(keyboardTexts(options.reply_markup)).toContain("🧠 Model Center");
    expect(keyboardTexts(options.reply_markup)).not.toContain("💬 New Chat");
  });

  it("sendKeyboardUpdate outside any topic runtime context keeps the Main keyboard", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    keyboardManager.initialize({ sendMessage } as never, CHAT_ID);
    await keyboardManager.sendKeyboardUpdate(CHAT_ID, true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , options] = sendMessage.mock.calls[0] as [number, string, Record<string, unknown>];
    expect(options.message_thread_id).toBeUndefined();
    expect(keyboardTexts(options.reply_markup)).toContain("💬 New Chat");
    expect(keyboardTexts(options.reply_markup)).not.toContain("🧠 Model Center");
  });

  it("an explicit sessionId always wins over the runtime context", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, SESSION_ID);
    const keyboard = runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.getKeyboard("other-session"));
    expect(keyboard).toBeUndefined();
  });
});

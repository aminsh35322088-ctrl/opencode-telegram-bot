import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCompactOutputMode: vi.fn(),
  getStoredAgent: vi.fn(),
  getStoredModel: vi.fn(),
  formatVariantForButton: vi.fn(),
  getQueuedPromptButtonLabels: vi.fn(),
  isChatPaused: vi.fn(),
  assistantRunState: { hasActiveRun: vi.fn() },
  getTopicRuntimeStateSync: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({ getCompactOutputMode: mocks.getCompactOutputMode, setCompactOutputMode: vi.fn() }));
vi.mock("../../../src/app/services/agent-selection-service.js", () => ({ getStoredAgent: mocks.getStoredAgent }));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({ getStoredModel: mocks.getStoredModel }));
vi.mock("../../../src/app/services/variant-selection-service.js", () => ({ formatVariantForButton: mocks.formatVariantForButton }));
vi.mock("../../../src/bot/keyboards/queued-prompt-button.js", () => ({ getQueuedPromptButtonLabels: mocks.getQueuedPromptButtonLabels }));
vi.mock("../../../src/app/managers/paused-session-manager.js", () => ({ isChatPaused: mocks.isChatPaused }));
vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({ assistantRunState: mocks.assistantRunState }));
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
    mocks.getTopicRuntimeStateSync.mockReturnValue(null);
    mocks.getCompactOutputMode.mockReturnValue(false);
  });

  it("bindTopic outside runtime context resolves Topic-scoped state and shows the active model", () => {
    mocks.getStoredModel.mockReturnValue({ providerID: "p", modelID: "global-default", name: "Global Default" });
    mocks.getTopicRuntimeStateSync.mockReturnValue({
      settings: { model: { providerID: "p2", modelID: "topicone" } },
    });

    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, "session-topic-model");
    const texts = keyboardTexts(keyboardManager.getKeyboard("session-topic-model"));

    expect(mocks.getTopicRuntimeStateSync).toHaveBeenCalledWith(CHAT_ID, THREAD_ID);
    expect(texts).toContain("🧠 topicone");
    expect(texts.some((text) => text.includes("Global Default"))).toBe(false);
  });

  it("re-syncs Topic-scoped state and refreshes the active model label", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, "session-resync");
    mocks.getTopicRuntimeStateSync.mockReturnValue({
      settings: { model: { providerID: "p3", modelID: "persisted-model", name: "Persisted" } },
    });

    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, "session-resync");
    const texts = keyboardTexts(keyboardManager.getKeyboard("session-resync"));

    expect(mocks.getTopicRuntimeStateSync).toHaveBeenCalledTimes(2);
    expect(texts).toContain("🧠 Persisted");
    expect(texts.some((text) => text.includes("Global Model"))).toBe(false);
  });

  it("returns the Main keyboard when no topic runtime context is active", () => {
    keyboardManager.initialize({} as never, CHAT_ID);
    const keyboard = keyboardManager.getKeyboard();
    const texts = keyboardTexts(keyboard);
    expect(texts).toContain("💬 New Chat");
    // Model choices live under Settings → Default Models; Main must not expose a model button.
    expect(texts).toContain("⚙️ Main Settings");
    expect(texts.some((text) => text.includes("🧠"))).toBe(false);
  });

  it("returns the Topic keyboard when called inside the topic runtime context", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, SESSION_ID);
    const keyboard = runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.getKeyboard());
    const texts = keyboardTexts(keyboard);
    expect(texts).toContain("🧠 Global Model");
    expect(texts).not.toContain("💬 New Chat");
    expect(texts).not.toContain("⏸️ Pause");
    expect(texts).not.toContain("▶️ Resume");
    expect(texts).not.toContain("🛑 Abort");
  });

  it("hides the Topic keyboard markup on outbound messages while the session is running", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, SESSION_ID);
    mocks.assistantRunState.hasActiveRun.mockReturnValue(true);
    expect(keyboardManager.getKeyboard(SESSION_ID)).toBeUndefined();

    mocks.assistantRunState.hasActiveRun.mockReturnValue(false);
    const idleKeyboard = keyboardManager.getKeyboard(SESSION_ID);
    expect(idleKeyboard).toBeDefined();
    const idleTexts = keyboardTexts(idleKeyboard);
    expect(idleTexts).toContain("🧠 Global Model");
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

  it("sendKeyboardUpdate keeps a durable persistent Topic keyboard and suppresses duplicate layouts", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 901, message_thread_id: THREAD_ID });
    const deleteMessage = vi.fn().mockResolvedValue(true);
    keyboardManager.bindTopic({ sendMessage, deleteMessage } as never, CHAT_ID, THREAD_ID, SESSION_ID);
    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, true));
    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, true));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, text, options] = sendMessage.mock.calls[0] as [number, string, Record<string, unknown>];
    expect(text).toBe("⌨️ Keyboard updated");
    expect(options.message_thread_id).toBe(THREAD_ID);
    expect(options.disable_notification).toBe(true);
    expect((options.reply_markup as { is_persistent?: boolean }).is_persistent).toBe(true);
    expect(keyboardTexts(options.reply_markup)).toContain("🧠 Global Model");
    expect(keyboardTexts(options.reply_markup)).not.toContain("💬 New Chat");
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("sendKeyboardUpdate outside a Topic routes to the persistent Main panel", async () => {
    const updateMain = vi.spyOn(keyboardManager, "sendMainInlineKeyboard").mockResolvedValue();
    keyboardManager.initialize({} as never, CHAT_ID);
    await keyboardManager.sendKeyboardUpdate(CHAT_ID, true);
    expect(updateMain).toHaveBeenCalledWith(CHAT_ID, expect.objectContaining({ modelID: "m" }), true);
  });

  it("delivers running controls once even within debounce, without reopening for duplicate updates", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 901, message_thread_id: THREAD_ID });
    keyboardManager.bindTopic({ sendMessage } as never, CHAT_ID, THREAD_ID, SESSION_ID);

    // Deliver once while idle so the user's keyboard exists before the run starts.
    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, true));
    const deliveredCount = sendMessage.mock.calls.length;
    expect(deliveredCount).toBe(1);

    mocks.assistantRunState.hasActiveRun.mockReturnValue(true);
    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, false));
    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, true));
    expect(sendMessage).toHaveBeenCalledTimes(deliveredCount + 1);
    const options = sendMessage.mock.calls.at(-1)![2];
    expect(keyboardTexts(options.reply_markup)).toContain("⏸️ Pause");
    expect(keyboardTexts(options.reply_markup)).toContain("🛑 Abort");
  });

  it("updates controls from running to paused", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 902, message_thread_id: THREAD_ID });
    keyboardManager.bindTopic({ sendMessage } as never, CHAT_ID, THREAD_ID, SESSION_ID);

    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, true));
    const deliveredCount = sendMessage.mock.calls.length;

    // Every state transition delivers its controls, including an immediate pause.
    mocks.assistantRunState.hasActiveRun.mockReturnValue(true);
    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, true));
    mocks.assistantRunState.hasActiveRun.mockReturnValue(false);
    mocks.isChatPaused.mockReturnValue(true);
    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, true));

    expect(sendMessage).toHaveBeenCalledTimes(deliveredCount + 2);
    const [, , options] = sendMessage.mock.calls.at(-1) as [number, string, Record<string, unknown>];
    expect(options.message_thread_id).toBe(THREAD_ID);
    expect(keyboardTexts(options.reply_markup)).toContain("▶️ Resume");
    expect(keyboardTexts(options.reply_markup)).toContain("🛑 Abort");
    expect(keyboardTexts(options.reply_markup)).not.toContain("⏸️ Pause");
  });

  it("delivers the initial Topic keyboard even when the first refresh arrives while running", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 903, message_thread_id: THREAD_ID });
    keyboardManager.bindTopic({ sendMessage } as never, CHAT_ID, THREAD_ID, "session-fresh");
    mocks.assistantRunState.hasActiveRun.mockReturnValue(true);

    await runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: "session-fresh" }, () => keyboardManager.sendKeyboardUpdate(CHAT_ID, true));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , options] = sendMessage.mock.calls[0] as [number, string, Record<string, unknown>];
    expect(options.message_thread_id).toBe(THREAD_ID);
  });

  it("getTopicSendTarget resolves the authoritative Topic thread for a bound session", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, SESSION_ID);
    expect(keyboardManager.getTopicSendTarget(SESSION_ID)).toEqual({ chatId: CHAT_ID, threadId: THREAD_ID });

    keyboardManager.initialize({} as never, CHAT_ID);
    expect(keyboardManager.getTopicSendTarget("unknown-session")).toBeUndefined();
  });

  it("explicit restore re-delivers an unchanged keyboard even during a run", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 904 });
    keyboardManager.bindTopic({ sendMessage } as never, CHAT_ID, THREAD_ID, SESSION_ID);
    mocks.assistantRunState.hasActiveRun.mockReturnValue(true);
    await keyboardManager.sendKeyboardUpdate(CHAT_ID, true, SESSION_ID);
    await keyboardManager.restoreTopicKeyboard(SESSION_ID);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const options = sendMessage.mock.calls.at(-1)![2];
    expect(options.message_thread_id).toBe(THREAD_ID);
    expect(options.reply_markup.remove_keyboard).toBeUndefined();
    expect(keyboardTexts(options.reply_markup)).toContain("🛑 Abort");
  });

  it("serializes concurrent refreshes so identical controls are delivered once", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 905 });
    keyboardManager.bindTopic({ sendMessage } as never, CHAT_ID, THREAD_ID, SESSION_ID);
    mocks.assistantRunState.hasActiveRun.mockReturnValue(true);
    await Promise.all([
      keyboardManager.sendKeyboardUpdate(CHAT_ID, true, SESSION_ID),
      keyboardManager.sendKeyboardUpdate(CHAT_ID, true, SESSION_ID),
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("restores idle controls after a run without waiting for debounce", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 906 });
    keyboardManager.bindTopic({ sendMessage } as never, CHAT_ID, THREAD_ID, SESSION_ID);
    mocks.assistantRunState.hasActiveRun.mockReturnValue(true);
    await keyboardManager.sendKeyboardUpdate(CHAT_ID, false, SESSION_ID);
    mocks.assistantRunState.hasActiveRun.mockReturnValue(false);
    await keyboardManager.sendKeyboardUpdate(CHAT_ID, false, SESSION_ID);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(keyboardTexts(sendMessage.mock.calls.at(-1)![2].reply_markup)).not.toContain("🛑 Abort");
  });

  it("an explicit sessionId always wins over the runtime context", () => {
    keyboardManager.bindTopic({} as never, CHAT_ID, THREAD_ID, SESSION_ID);
    const keyboard = runInTopicRuntimeContext({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID }, () => keyboardManager.getKeyboard("other-session"));
    expect(keyboard).toBeUndefined();
  });
});

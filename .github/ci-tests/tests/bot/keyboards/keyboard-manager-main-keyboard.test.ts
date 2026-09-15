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
vi.mock("../../../src/bot/services/telegram-topic-runtime.js", () => ({ getUnscopedTelegramApi: (api: unknown) => api }));

import { keyboardManager } from "../../../src/bot/keyboards/keyboard-manager.js";

const CHAT_ID = -1001234567890;

function keyboardTexts(keyboard: unknown): string[] {
  const rows = (keyboard as { keyboard?: Array<Array<{ text?: string }>> }).keyboard ?? [];
  return rows.flat().map((button) => button?.text ?? "");
}

describe("keyboard-manager Main scope reply keyboard", () => {
  let api: { sendMessage: ReturnType<typeof vi.fn>; deleteMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStoredModel.mockReturnValue({ providerID: "p", modelID: "m", name: "Global Model" });
    mocks.getStoredAgent.mockReturnValue("build");
    mocks.formatVariantForButton.mockReturnValue("Default");
    mocks.getQueuedPromptButtonLabels.mockReturnValue([]);
    mocks.isChatPaused.mockReturnValue(false);
    mocks.assistantRunState.hasActiveRun.mockReturnValue(false);
    mocks.getMainTelegramThreadIdSync.mockReturnValue(null);
    mocks.getTopicRuntimeStateSync.mockReturnValue(null);
    mocks.getCompactOutputMode.mockReturnValue(false);
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    keyboardManager.initialize(api as never, CHAT_ID);
  });

  it("builds the Main controls keyboard with the same buttons as the glass panel", () => {
    const texts = keyboardTexts(keyboardManager.mainScopeReplyKeyboard());
    expect(texts).toContain("💬 New Chat");
    expect(texts).toContain("🎨 New Image Chat");
    expect(texts).toContain("🕘 History");
    expect(texts).toContain("⚙️ Main Settings");
  });

  it("applies the keyboard once per chat until a Topic keyboard becomes active again", async () => {
    const chat = CHAT_ID - 11;
    await keyboardManager.applyMainScopeReplyKeyboardOnce(chat);
    await keyboardManager.applyMainScopeReplyKeyboardOnce(chat);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    keyboardManager.markTopicKeyboardActive(chat);
    await keyboardManager.applyMainScopeReplyKeyboardOnce(chat);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("noteMainScopeKeyboardApplied suppresses the notice when a reply already carried the keyboard", async () => {
    const chat = CHAT_ID - 22;
    keyboardManager.noteMainScopeKeyboardApplied(chat);
    await keyboardManager.applyMainScopeReplyKeyboardOnce(chat);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("resets the latch when applying fails so the next message retries", async () => {
    const chat = CHAT_ID - 33;
    api.sendMessage.mockRejectedValueOnce(new Error("telegram down"));
    await expect(keyboardManager.applyMainScopeReplyKeyboardOnce(chat)).rejects.toThrow("telegram down");
    await keyboardManager.applyMainScopeReplyKeyboardOnce(chat);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });
});

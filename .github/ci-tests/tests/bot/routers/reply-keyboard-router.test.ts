import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isMainTelegramTopic: vi.fn(),
  findTelegramTopicBindingByThread: vi.fn(),
  getTopicRuntimeContext: vi.fn(),
  getCurrentSession: vi.fn(),
  getStoredModel: vi.fn(),
  assistantRunState: { hasActiveRun: vi.fn(), hasActiveRuns: vi.fn() },
  interactionManager: { getSnapshot: vi.fn(), clear: vi.fn(), clearAll: vi.fn(), start: vi.fn(), isActive: vi.fn(), clearSession: vi.fn() },
  keyboardManager: { getState: vi.fn(), getKeyboard: vi.fn() },
  showModelCenterMenu: vi.fn(),
  showAgentSelectionMenu: vi.fn(),
  showVariantSelectionMenu: vi.fn(),
  handleContextButtonPress: vi.fn(),
  settingsCommand: vi.fn(),
  sessionsCommand: vi.fn(),
  newCommand: vi.fn(),
  abortCurrentOperation: vi.fn(),
  pauseCurrentChat: vi.fn(),
  resumePausedChat: vi.fn(),
  showTelegramTopicDeleteConfirmation: vi.fn(),
  findQueuedPromptByButtonLabel: vi.fn(),
  promptQueue: { removeById: vi.fn(), __resetForTests: vi.fn() },
  clearImageMode: vi.fn(),
  isProviderWizardActive: vi.fn(),
  isIntegrationWizardActive: vi.fn(),
  getCompactOutputMode: vi.fn(),
  setCompactOutputMode: vi.fn(),
}));

vi.mock("../../../src/app/services/telegram-main-topic-store.js", () => ({ isMainTelegramTopic: mocks.isMainTelegramTopic }));
vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({ findTelegramTopicBindingByThread: mocks.findTelegramTopicBindingByThread }));
vi.mock("../../../src/app/services/topic-runtime-context.js", () => ({ getTopicRuntimeContext: mocks.getTopicRuntimeContext }));
vi.mock("../../../src/app/services/session-service.js", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({ getStoredModel: mocks.getStoredModel }));
vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({ assistantRunState: mocks.assistantRunState }));
vi.mock("../../../src/app/managers/interaction-manager.js", () => ({ interactionManager: mocks.interactionManager }));
vi.mock("../../../src/app/managers/prompt-queue-manager.js", () => ({ promptQueue: mocks.promptQueue }));
vi.mock("../../../src/app/services/image-mode-service.js", () => ({ clearImageMode: mocks.clearImageMode }));
vi.mock("../../../src/app/services/agent-selection-service.js", () => ({ getStoredAgent: vi.fn() }));
vi.mock("../../../src/app/stores/settings-store.js", () => ({ getCompactOutputMode: mocks.getCompactOutputMode, setCompactOutputMode: mocks.setCompactOutputMode }));
vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({ keyboardManager: mocks.keyboardManager }));
vi.mock("../../../src/bot/keyboards/queued-prompt-button.js", () => ({ findQueuedPromptByButtonLabel: mocks.findQueuedPromptByButtonLabel }));
vi.mock("../../../src/bot/menus/model-center-menu.js", () => ({ showModelCenterMenu: mocks.showModelCenterMenu }));
vi.mock("../../../src/bot/menus/agent-selection-menu.js", () => ({ showAgentSelectionMenu: mocks.showAgentSelectionMenu }));
vi.mock("../../../src/bot/menus/variant-selection-menu.js", () => ({ showVariantSelectionMenu: mocks.showVariantSelectionMenu }));
vi.mock("../../../src/bot/menus/context-control-menu.js", () => ({ handleContextButtonPress: mocks.handleContextButtonPress }));
vi.mock("../../../src/bot/commands/settings-command.js", () => ({ settingsCommand: mocks.settingsCommand }));
vi.mock("../../../src/bot/commands/sessions-command.js", () => ({ sessionsCommand: mocks.sessionsCommand }));
vi.mock("../../../src/bot/commands/new-command.js", () => ({ newCommand: mocks.newCommand }));
vi.mock("../../../src/bot/commands/abort-command.js", () => ({ abortCurrentOperation: mocks.abortCurrentOperation }));
vi.mock("../../../src/bot/commands/pause-command.js", () => ({ pauseCurrentChat: mocks.pauseCurrentChat, resumePausedChat: mocks.resumePausedChat }));
vi.mock("../../../src/bot/services/telegram-topic-delete-handler.js", () => ({ showTelegramTopicDeleteConfirmation: mocks.showTelegramTopicDeleteConfirmation }));
vi.mock("../../../src/bot/commands/providers-command.js", () => ({ isProviderWizardActive: mocks.isProviderWizardActive, clearProviderWizard: vi.fn(), providersCommand: vi.fn() }));
vi.mock("../../../src/bot/commands/integrations-command.js", () => ({ isIntegrationWizardActive: mocks.isIntegrationWizardActive, clearIntegrationWizard: vi.fn(), integrationsCommand: vi.fn() }));
vi.mock("../../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { registerReplyKeyboardRouter } from "../../../src/bot/routers/reply-keyboard-router.js";

const CHAT_ID = -1001234567890;
const THREAD_ID = 42;
const SESSION_ID = "sess-topic-1";

function makeTopicContext(text: string) {
  return {
    chat: { id: CHAT_ID },
    message: { text, message_thread_id: THREAD_ID },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function registerHandler(): { handler: (ctx: unknown, next: () => Promise<void>) => Promise<void>; next: ReturnType<typeof vi.fn> } {
  const bot = { on: vi.fn(), hears: vi.fn() };
  registerReplyKeyboardRouter(bot as never, { bot: bot as never, ensureEventSubscription: vi.fn() });
  const call = bot.on.mock.calls.find(([event]) => event === "message:text");
  const handler = call?.[1] as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
  return { handler, next: vi.fn() };
}

describe("bot/routers/reply-keyboard-router topic scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMainTelegramTopic.mockResolvedValue(false);
    mocks.findTelegramTopicBindingByThread.mockResolvedValue({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID, directory: "/proj", createdAt: "", updatedAt: "" });
    mocks.getTopicRuntimeContext.mockReturnValue({ chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID });
    mocks.getCurrentSession.mockReturnValue({ id: SESSION_ID, directory: "/proj" });
    mocks.getStoredModel.mockReturnValue({ providerID: "p", modelID: "m", name: "Global Model" });
    mocks.assistantRunState.hasActiveRun.mockReturnValue(false);
    mocks.assistantRunState.hasActiveRuns.mockReturnValue(false);
    mocks.interactionManager.getSnapshot.mockReturnValue(null);
    mocks.keyboardManager.getState.mockReturnValue(undefined);
    mocks.keyboardManager.getKeyboard.mockReturnValue(undefined);
    mocks.getCompactOutputMode.mockReturnValue(false);
    mocks.isProviderWizardActive.mockReturnValue(false);
    mocks.isIntegrationWizardActive.mockReturnValue(false);
    mocks.findQueuedPromptByButtonLabel.mockReturnValue(null);
  });

  const topicButtons = ["🛑 Abort", "⏸️ Pause", "▶️ Resume", "🎨 Image AI", "📦 Compact: OFF", "🧠 Model Center", "🗑️ Delete Chat", "⚙️ Topic Settings"];

  for (const button of topicButtons) {
    it(`consumes "${button}" inside a topic without forwarding it as a prompt`, async () => {
      const { handler, next } = registerHandler();
      const ctx = makeTopicContext(button);

      await handler(ctx, next);

      expect(next).not.toHaveBeenCalled();
    });
  }

  it("dispatches Abort inside a topic", async () => {
    const { handler, next } = registerHandler();
    await handler(makeTopicContext("🛑 Abort"), next);
    expect(mocks.abortCurrentOperation).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("dispatches Model Center inside a topic", async () => {
    const { handler, next } = registerHandler();
    await handler(makeTopicContext("🧠 Model Center"), next);
    expect(mocks.showModelCenterMenu).toHaveBeenCalledTimes(1);
  });

  it("dispatches Topic Settings inside a topic", async () => {
    const { handler, next } = registerHandler();
    await handler(makeTopicContext("⚙️ Topic Settings"), next);
    expect(mocks.settingsCommand).toHaveBeenCalledTimes(1);
  });

  it("consumes dynamic agent buttons inside a topic instead of leaking them as prompts", async () => {
    const { handler, next } = registerHandler();
    await handler(makeTopicContext("📋 Code Agent"), next);
    expect(mocks.showAgentSelectionMenu).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("consumes dynamic variant buttons inside a topic", async () => {
    const { handler, next } = registerHandler();
    await handler(makeTopicContext("💡 Balanced"), next);
    expect(mocks.showVariantSelectionMenu).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("consumes dynamic model-name buttons inside a topic", async () => {
    mocks.keyboardManager.getState.mockReturnValue({ sessionId: SESSION_ID, currentModel: { providerID: "p", modelID: "m", name: "Topic Model" } });
    const { handler, next } = registerHandler();
    await handler(makeTopicContext("🧠 p/m Topic Model"), next);
    expect(next).not.toHaveBeenCalled();
  });

  it("consumes any 🧠 label inside a topic even when it matches no stored model", async () => {
    const { handler, next } = registerHandler();
    await handler(makeTopicContext("🧠 Unknown Future Model"), next);
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards ordinary prompt text through inside a topic", async () => {
    const { handler, next } = registerHandler();
    await handler(makeTopicContext("fix the login bug"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("consumes main-only buttons inside a topic (wrong scope, never a prompt)", async () => {
    const { handler, next } = registerHandler();
    await handler(makeTopicContext("🕘 History"), next);
    expect(mocks.sessionsCommand).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("handles New Chat in main scope and forwards ordinary prompts", async () => {
    mocks.findTelegramTopicBindingByThread.mockResolvedValue(null);
    mocks.getTopicRuntimeContext.mockReturnValue(null);
    const { handler, next } = registerHandler();
    await handler({ chat: { id: CHAT_ID }, message: { text: "💬 New Chat" }, reply: vi.fn() }, next);
    expect(mocks.newCommand).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();

    const { handler: h2, next: n2 } = registerHandler();
    await h2({ chat: { id: CHAT_ID }, message: { text: "hello main" }, reply: vi.fn() }, n2);
    expect(n2).toHaveBeenCalledTimes(1);
  });
});

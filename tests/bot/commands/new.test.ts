import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { newCommand } from "../../../src/bot/commands/new-command.js";
import { foregroundSessionState } from "../../../src/app/managers/foreground-session-state-manager.js";

const mocked = vi.hoisted(() => ({
  sessionCreateMock: vi.fn(),
  getCurrentProjectMock: vi.fn(),
  attachToSessionMock: vi.fn(),
  ensureEventSubscriptionMock: vi.fn(),
  isForegroundBusyMock: vi.fn().mockReturnValue(false),
  replyBusyBlockedMock: vi.fn(),
  runInTopicRuntimeContextMock: vi.fn(),
  getTopicDefaultsMock: vi.fn(),
  createTelegramTopicWorkspaceMock: vi.fn(),
  openSessionInTelegramTopicMock: vi.fn(),
  ingestSessionInfoForCacheMock: vi.fn(),
  createTopicKeyboardMock: vi.fn(),
  pinNavigationInGeneralMock: vi.fn(),
  installTopicNavigationMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      create: mocked.sessionCreateMock,
    },
  },
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: mocked.getCurrentProjectMock,
  getTopicDefaults: mocked.getTopicDefaultsMock,
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  setCurrentSession: vi.fn(),
  getCurrentSession: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../src/app/services/session-cache-service.js", () => ({
  ingestSessionInfoForCache: mocked.ingestSessionInfoForCacheMock,
  __resetSessionDirectoryCacheForTests: vi.fn(),
}));

vi.mock("../../../src/app/managers/interaction-manager.js", () => ({
  interactionManager: { clear: vi.fn() },
  clearAllInteractionState: vi.fn(),
}));

vi.mock("../../../src/app/managers/summary-aggregation-manager.js", () => ({
  summaryAggregator: { clear: vi.fn() },
}));

vi.mock("../../../src/bot/pinned/pinned-message-manager.js", () => ({
  pinnedMessageManager: {
    isInitialized: vi.fn(() => false),
    initialize: vi.fn(),
    onSessionChange: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    initialize: vi.fn(),
    bindTopic: vi.fn(),
    updateAgent: vi.fn(),
    updateModel: vi.fn(),
    getContextInfo: vi.fn(() => null),
    setPaused: vi.fn(),
  },
}));

vi.mock("../../../src/app/managers/paused-session-manager.js", () => ({
  clearPausedSession: vi.fn(),
}));

vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: vi.fn(() => "build"),
  resolveProjectAgent: vi.fn(async (agentName?: string) => agentName ?? "build"),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: vi.fn(() => ({ providerID: "openai", modelID: "gpt-5", variant: "default" })),
}));

vi.mock("../../../src/app/services/variant-selection-service.js", () => ({
  formatVariantForButton: vi.fn(() => "Default"),
}));

vi.mock("../../../src/bot/keyboards/main-reply-keyboard.js", () => ({
  createMainKeyboard: vi.fn(() => ({ keyboard: true })),
  createTopicKeyboard: mocked.createTopicKeyboardMock,
}));

vi.mock("../../../src/app/services/attach-service.js", () => ({
  attachToSession: mocked.attachToSessionMock,
}));

vi.mock("../../../src/app/services/run-control-service.js", () => ({
  isForegroundBusy: mocked.isForegroundBusyMock,
}));

vi.mock("../../../src/app/services/telegram-topic-workspace-service.js", () => ({
  createTelegramTopicWorkspace: mocked.createTelegramTopicWorkspaceMock,
  deleteTelegramTopicWorkspace: vi.fn(),
}));

vi.mock("../../../src/app/services/telegram-topic-session-service.js", () => ({
  openSessionInTelegramTopic: mocked.openSessionInTelegramTopicMock,
  pinNavigationInGeneral: mocked.pinNavigationInGeneralMock,
  installTopicNavigation: mocked.installTopicNavigationMock,
}));

vi.mock("../../../src/app/services/topic-runtime-context.js", () => ({
  getTopicRuntimeContext: vi.fn().mockReturnValue(null),
  runInTopicRuntimeContext: mocked.runInTopicRuntimeContextMock,
}));

vi.mock("../../../src/app/stores/topic-runtime-state-store.js", () => ({
  initializeTopicRuntimeState: vi.fn(),
  ensureTopicRuntimeStateSync: vi.fn(),
}));

vi.mock("../../../src/bot/services/telegram-topic-runtime.js", () => ({
  createTopicAwareBot: vi.fn((_bot: unknown) => _bot),
  setActiveTelegramTopic: vi.fn(),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../src/bot/messages/busy-blocked-renderer.js", () => ({
  replyBusyBlocked: mocked.replyBusyBlockedMock,
}));

function createContext(): Context {
  return {
    chat: { id: 123 },
    api: {},
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Context;
}

function createDeps() {
  const sendMessageMock = vi.fn().mockResolvedValue({ message_id: 1 });
  return {
    bot: { api: { sendMessage: sendMessageMock } } as unknown as Bot<Context>,
    ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    sendMessageMock,
  };
}

describe("bot/commands/new", () => {
  beforeEach(() => {
    foregroundSessionState.__resetForTests();
    mocked.sessionCreateMock.mockReset();
    mocked.getCurrentProjectMock.mockReset();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "project-1", worktree: "/repo" });
    mocked.attachToSessionMock.mockReset();
    mocked.attachToSessionMock.mockResolvedValue({
      busy: false,
      alreadyAttached: false,
      restoredQuestion: false,
      restoredPermissions: 0,
    });
    mocked.ensureEventSubscriptionMock.mockReset();
    mocked.isForegroundBusyMock.mockReset();
    mocked.isForegroundBusyMock.mockReturnValue(false);
    mocked.replyBusyBlockedMock.mockReset();
    mocked.runInTopicRuntimeContextMock.mockReset();
    mocked.runInTopicRuntimeContextMock.mockImplementation(
      (_ctx: unknown, fn: () => unknown) => fn(),
    );
    mocked.getTopicDefaultsMock.mockReset();
    mocked.getTopicDefaultsMock.mockReturnValue({
      compactOutputMode: false,
      showThinkingContent: true,
      responseStreamingMode: "edit",
      messageFormatMode: "markdown",
      showAssistantRunFooter: true,
      sendDiffFileAttachments: true,
      promptQueueEnabled: false,
    });
    mocked.createTelegramTopicWorkspaceMock.mockReset();
    mocked.createTelegramTopicWorkspaceMock.mockResolvedValue("/repo");
    mocked.openSessionInTelegramTopicMock.mockReset();
    mocked.openSessionInTelegramTopicMock.mockResolvedValue({
      chatId: 123,
      threadId: 1,
      sessionId: "session-2",
      directory: "/repo",
      createdAt: "",
      updatedAt: "",
    });
    mocked.ingestSessionInfoForCacheMock.mockReset();
    mocked.ingestSessionInfoForCacheMock.mockResolvedValue(undefined);
    mocked.createTopicKeyboardMock.mockReset();
    mocked.createTopicKeyboardMock.mockReturnValue({ keyboard: true });
    mocked.pinNavigationInGeneralMock.mockReset();
    mocked.pinNavigationInGeneralMock.mockResolvedValue(undefined);
    mocked.installTopicNavigationMock.mockReset();
    mocked.installTopicNavigationMock.mockResolvedValue(undefined);
  });

  it("blocks new session creation while foreground session is busy", async () => {
    mocked.isForegroundBusyMock.mockReturnValue(true);

    const ctx = createContext();
    await newCommand(ctx as never, createDeps());

    expect(mocked.sessionCreateMock).not.toHaveBeenCalled();
    expect(mocked.replyBusyBlockedMock).toHaveBeenCalledWith(ctx);
  });

  it("creates and immediately follows the new session", async () => {
    mocked.sessionCreateMock.mockResolvedValueOnce({
      data: { id: "session-2", title: "Session Two" },
      error: null,
    });

    const ctx = createContext();
    const deps = createDeps();
    await newCommand(ctx as never, deps);

    expect(mocked.sessionCreateMock).toHaveBeenCalledTimes(1);
    expect(mocked.attachToSessionMock).toHaveBeenCalledWith({
      bot: expect.any(Object),
      chatId: 123,
      session: {
        id: "session-2",
        title: "Session Two",
        directory: "/repo",
      },
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });
    expect(deps.sendMessageMock).toHaveBeenCalledWith(
      123,
      expect.stringContaining("Session Two"),
    );
  });

  it("allows concurrent session creation", async () => {
    mocked.sessionCreateMock.mockResolvedValue({
      data: { id: "session-2", title: "Session Two" },
      error: null,
    });

    const ctx1 = createContext();
    const ctx2 = createContext();
    const deps1 = createDeps();
    const deps2 = createDeps();

    const first = newCommand(ctx1 as never, deps1);
    const second = newCommand(ctx2 as never, deps2);

    await Promise.all([first, second]);

    expect(mocked.sessionCreateMock).toHaveBeenCalledTimes(2);
    expect(mocked.attachToSessionMock).toHaveBeenCalledTimes(2);
  });
});

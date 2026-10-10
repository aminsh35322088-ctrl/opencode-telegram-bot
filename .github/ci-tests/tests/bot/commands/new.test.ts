import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { Bot, Context } from "grammy";
import { newCommand } from "../../../src/bot/commands/new-command.js";
import { foregroundSessionState } from "../../../src/app/managers/foreground-session-state-manager.js";

const mocked = vi.hoisted(() => ({
  remoteEnabled: vi.fn(),
  remoteCreate: vi.fn(),
  deleteWorkspace: vi.fn(),
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
  buildModelRoutingSummaryMock: vi.fn(),
  ensureMcpRuntimeForDirectoryMock: vi.fn(),
  resolveCoreTopicBindingMock: vi.fn(),
  isCurrentCoreSessionRouteMock: vi.fn(),
  deleteTelegramTopicSessionMock: vi.fn(),
}));

vi.mock("../../../src/control-plane/topic-node-lifecycle.js",()=>({isTopicNodeCreationEnabled:mocked.remoteEnabled,createRemoteTopicSession:mocked.remoteCreate}));

vi.mock("../../../src/core/native-core-service.js", () => ({
  resolveCoreTopicBinding: mocked.resolveCoreTopicBindingMock,
  isCurrentCoreSessionRoute: mocked.isCurrentCoreSessionRouteMock,
}));

vi.mock("../../../src/bot/services/core-session-api.js", () => ({
  createCoreSessionApi: (api: unknown) => api,
}));

vi.mock("../../../src/app/services/telegram-topic-delete-service.js", () => ({
  deleteTelegramTopicSession: mocked.deleteTelegramTopicSessionMock,
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
    enterTopicMode: vi.fn().mockResolvedValue(undefined),
    clearMainInlineMessage: vi.fn().mockResolvedValue(undefined),
    sendMainInlineKeyboard: vi.fn().mockResolvedValue(undefined),
    sendKeyboardUpdate: vi.fn().mockResolvedValue(undefined),
    getKeyboard: vi.fn().mockReturnValue(undefined),
    markKeyboardDelivered: vi.fn(),
  },
}));

vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: vi.fn(() => "build"),
  resolveProjectAgent: vi.fn(async (agentName?: string) => agentName ?? "build"),
}));

vi.mock("../../../src/app/services/model-routing-summary-service.js", () => ({
  buildModelRoutingSummary: mocked.buildModelRoutingSummaryMock,
}));

vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  ensureMcpRuntimeForDirectory: mocked.ensureMcpRuntimeForDirectoryMock,
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
  deleteTelegramTopicWorkspace: mocked.deleteWorkspace,
}));

vi.mock("../../../src/app/services/telegram-topic-session-service.js", () => ({
  openSessionInTelegramTopic: mocked.openSessionInTelegramTopicMock,
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

let nextUpdateId=1;
function createContext(): Context {
  return {
    update: {update_id: nextUpdateId++},
    chat: { id: 123 },
    api: {},
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Context;
}

function createDeps() {
  let nextMessageId = 700;
  const sendMessageMock = vi.fn().mockImplementation(async () => ({ message_id: nextMessageId++ }));
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
    mocked.ensureMcpRuntimeForDirectoryMock.mockReset().mockResolvedValue({ restored: 1, failed: 0 });
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
      threadId: 42,
      sessionId: "session-2",
      directory: "/repo",
      createdAt: "",
      updatedAt: "",
      title: "Chat #01",
    });
    mocked.resolveCoreTopicBindingMock.mockReset().mockReturnValue({
      bindingId: "123:42",
      chatId: 123,
      threadId: 42,
      sessionId: "session-2",
      normalizedDirectory: path.resolve("/repo"),
      bindingGeneration: 1,
    });
    mocked.isCurrentCoreSessionRouteMock.mockReset().mockReturnValue(true);
    mocked.deleteTelegramTopicSessionMock.mockReset().mockResolvedValue(undefined);
    mocked.ingestSessionInfoForCacheMock.mockReset();
    mocked.ingestSessionInfoForCacheMock.mockResolvedValue(undefined);
    mocked.createTopicKeyboardMock.mockReset();
    mocked.createTopicKeyboardMock.mockReturnValue({ keyboard: true });
    mocked.buildModelRoutingSummaryMock.mockReset();
    mocked.buildModelRoutingSummaryMock.mockResolvedValue("🧠 GPT 5 · OpenAI\n\n💬 Chat ✅");
  });

  it("creates a new session even while the foreground session is busy", async () => {
    mocked.isForegroundBusyMock.mockReturnValue(true);
    mocked.sessionCreateMock.mockResolvedValueOnce({
      data: { id: "session-2", title: "Session Two" },
      error: null,
    });

    const ctx = createContext();
    await newCommand(ctx as never, createDeps());

    expect(mocked.sessionCreateMock).toHaveBeenCalledTimes(1);
    expect(mocked.replyBusyBlockedMock).not.toHaveBeenCalled();
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
        title: "Chat #01",
        directory: "/repo",
      },
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });
    const summaryCall = deps.sendMessageMock.mock.calls.find((call) => String(call[1]).includes("New AI Topic ready"));
    expect(summaryCall).toBeDefined();
    expect(summaryCall?.[2]).toMatchObject({
      message_thread_id: 42,
      reply_markup: { keyboard: true },
    });
    expect(deps.sendMessageMock.mock.calls.at(-1)?.[2]).toMatchObject({ message_thread_id: 42 });
    expect(deps.sendMessageMock.mock.calls.every(call => !call[2]?.reply_parameters)).toBe(true);
    expect(mocked.buildModelRoutingSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerID: "openai", modelID: "gpt-5" }),
      "/repo",
    );
    expect(mocked.ensureMcpRuntimeForDirectoryMock).toHaveBeenCalledWith("/repo");
    expect((deps.sendMessageMock.mock.invocationCallOrder[0] ?? Infinity)).toBeLessThan(
      mocked.attachToSessionMock.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("does not send the first Topic message after its Core binding changes", async () => {
    mocked.sessionCreateMock.mockResolvedValueOnce({ data: { id: "session-2", title: "Two" } });
    mocked.isCurrentCoreSessionRouteMock.mockReturnValue(false);
    const deps = createDeps();

    await newCommand(createContext() as never, deps);

    expect(deps.sendMessageMock).not.toHaveBeenCalled();
    expect(mocked.deleteTelegramTopicSessionMock).toHaveBeenCalledTimes(1);
  });

  it("publishes Main navigation before the final Topic message for native Continue", async () => {
    mocked.sessionCreateMock.mockResolvedValueOnce({ data: { id: "session-2", title: "Two" } });
    const { keyboardManager } = await import("../../../src/bot/keyboards/keyboard-manager.js");
    const deps = createDeps();
    vi.mocked(keyboardManager.sendMainInlineKeyboard).mockImplementationOnce(async () => {
      await deps.sendMessageMock(123, "Main navigation", { reply_markup: { inline_keyboard: [] } });
    });
    await newCommand(createContext() as never, deps);
    expect(deps.sendMessageMock.mock.calls.at(-1)?.[2]).toMatchObject({ message_thread_id: 42 });
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


describe('remote New Chat retry ownership',()=>{
 it('acknowledges a completed retry without UI initialization or destructive cleanup',async()=>{
  mocked.remoteEnabled.mockReturnValue(true);
  mocked.createTelegramTopicWorkspaceMock.mockResolvedValue('/new-temp');
  mocked.remoteCreate.mockResolvedValue({reused:true,binding:{chatId:123,threadId:42,sessionId:'live',directory:'/live'}});
  mocked.attachToSessionMock.mockRejectedValue(new Error('UI failure must not run'));
  const ctx=createContext();await newCommand(ctx as never,createDeps());
  expect(mocked.deleteWorkspace).toHaveBeenCalledWith('/new-temp');
  expect(mocked.sessionCreateMock).not.toHaveBeenCalled();
  expect(mocked.attachToSessionMock).not.toHaveBeenCalled();
  expect(mocked.deleteTelegramTopicSessionMock).not.toHaveBeenCalled();
 });
 it('coalesces concurrent duplicate Telegram updates before creating workspaces',async()=>{
  mocked.remoteEnabled.mockReturnValue(true);
  mocked.createTelegramTopicWorkspaceMock.mockResolvedValue('/new-temp');
  mocked.remoteCreate.mockResolvedValue({reused:true,binding:{directory:'/live'}});
  const ctx=createContext();const first=newCommand(ctx as never,createDeps());const second=newCommand(ctx as never,createDeps());
  expect(first).toBe(second);await first;expect(mocked.createTelegramTopicWorkspaceMock).toHaveBeenCalledTimes(1);
 });
});

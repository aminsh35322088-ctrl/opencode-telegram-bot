import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";

const mocks = vi.hoisted(() => ({
  sessionGetMock: vi.fn(),
  hasActiveRunMock: vi.fn(() => false),
  assistantClearAllMock: vi.fn(),
  foregroundClearAllMock: vi.fn(),
  rustDeskClearAllMock: vi.fn(),
  toolActivityClearAllMock: vi.fn(),
  deleteTopicMock: vi.fn(async () => {}),
  listBindingsMock: vi.fn(),
  reconcileWorkspacesMock: vi.fn(async () => [] as string[]),
  workspaceRootsMock: vi.fn(),
  clearAllMemoriesMock: vi.fn(async () => 0),
  listMemoriesMock: vi.fn(async () => [] as unknown[]),
  clearSessionDirectoryCacheMock: vi.fn(),
  clearRuntimeStatesMock: vi.fn(async () => {}),
  listRuntimeStatesMock: vi.fn(async () => [] as unknown[]),
  promptQueueClearAllMock: vi.fn(),
  promptAttachmentClearAllMock: vi.fn(),
  clearInteractionsMock: vi.fn(),
  detachMock: vi.fn(),
  flushAppStateMock: vi.fn(async () => {}),
  persistentPathsMock: vi.fn(() => [] as string[]),
  resetSettingsMock: vi.fn(),
  flushSettingsMock: vi.fn(async () => {}),
  clearGithubTokenMock: vi.fn(async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  }),
  clearRailwayTokenMock: vi.fn(async () => {
    delete process.env.RAILWAY_TOKEN;
    delete process.env.RAILWAY_API_TOKEN;
  }),
  scheduledHasRunningMock: vi.fn(() => false),
  scheduledClearAllMock: vi.fn(() => true),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { get: mocks.sessionGetMock } },
}));
vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({
  assistantRunState: {
    hasActiveRun: mocks.hasActiveRunMock,
    clearAll: mocks.assistantClearAllMock,
  },
}));
vi.mock("../../../src/app/managers/foreground-session-state-manager.js", () => ({
  foregroundSessionState: { clearAll: mocks.foregroundClearAllMock },
}));
vi.mock("../../../src/app/managers/rustdesk-secure-input-manager.js", () => ({
  rustDeskSecureInputManager: { clearAll: mocks.rustDeskClearAllMock },
}));
vi.mock("../../../src/app/managers/tool-activity-manager.js", () => ({
  clearAllToolActivity: mocks.toolActivityClearAllMock,
  __resetToolActivityForTests: vi.fn(),
}));
vi.mock("../../../src/app/services/telegram-topic-delete-service.js", () => ({
  deleteTelegramTopicSession: mocks.deleteTopicMock,
  isOpencodeSessionNotFoundError: (error: unknown) => {
    const candidate = error as { name?: unknown; status?: unknown; data?: { message?: unknown } };
    if (candidate?.status === 404 || candidate?.name === "NotFoundError") return true;
    const message = candidate?.data?.message;
    return typeof message === "string" && /session.*not found/i.test(message);
  },
}));
vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({
  listTelegramTopicBindings: mocks.listBindingsMock,
}));
vi.mock("../../../src/app/services/telegram-topic-workspace-service.js", () => ({
  getTelegramTopicWorkspaceRoot: () => mocks.workspaceRootsMock()[0],
  getTelegramTopicWorkspaceRoots: mocks.workspaceRootsMock,
  reconcileTopicWorkspaces: mocks.reconcileWorkspacesMock,
}));
vi.mock("../../../src/app/services/memory-service.js", () => ({
  clearAllMemories: mocks.clearAllMemoriesMock,
  listMemories: mocks.listMemoriesMock,
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  clearSessionDirectoryCache: mocks.clearSessionDirectoryCacheMock,
  resetGlobalSettingsForFactory: mocks.resetSettingsMock,
  flushSettings: mocks.flushSettingsMock,
}));
vi.mock("../../../src/app/stores/topic-runtime-state-store.js", () => ({
  clearAllTopicRuntimeStates: mocks.clearRuntimeStatesMock,
  listTopicRuntimeStates: mocks.listRuntimeStatesMock,
}));
vi.mock("../../../src/app/managers/prompt-queue-manager.js", () => ({
  promptQueue: {
    clearAll: mocks.promptQueueClearAllMock,
    __resetForTests: vi.fn(),
  },
}));
vi.mock("../../../src/app/managers/prompt-attachment-manager.js", () => ({
  promptAttachment: {
    clearAll: mocks.promptAttachmentClearAllMock,
    __resetForTests: vi.fn(),
  },
}));
vi.mock("../../../src/app/managers/interaction-manager.js", () => ({
  interactionManager: {
    clear: vi.fn(),
    clearAll: mocks.clearInteractionsMock,
  },
  clearAllInteractionState: mocks.clearInteractionsMock,
}));
vi.mock("../../../src/app/services/attach-service.js", () => ({
  detachAttachedSession: mocks.detachMock,
}));
vi.mock("../../../src/app/stores/app-state-store.js", () => ({
  flushAppState: mocks.flushAppStateMock,
}));
vi.mock("../../../src/app/services/persistent-state-registry.js", () => ({
  getPersistentStatePaths: mocks.persistentPathsMock,
}));
vi.mock("../../../src/app/services/github-integration-service.js", () => ({
  clearGithubToken: mocks.clearGithubTokenMock,
}));
vi.mock("../../../src/app/services/railway-integration-service.js", () => ({
  clearRailwayToken: mocks.clearRailwayTokenMock,
}));
vi.mock("../../../src/app/services/scheduled-task-runtime-service.js", () => ({
  scheduledTaskRuntime: {
    hasRunningTasks: mocks.scheduledHasRunningMock,
    clearAll: mocks.scheduledClearAllMock,
  },
}));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { factoryReset, resetHistory } from "../../../src/app/services/telegram-reset-service.js";

const binding = {
  chatId: 5,
  threadId: 7,
  sessionId: "ses_test",
  directory: "/ws/5/ses_test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
describe("telegram-reset-service", () => {
  let tempRoot = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-reset-test-"));
    mocks.workspaceRootsMock.mockReturnValue([tempRoot]);
    mocks.listBindingsMock.mockResolvedValue([]);
    mocks.sessionGetMock.mockResolvedValue({ data: undefined, error: { name: "NotFoundError", data: { message: "Session not found" } } });
    mocks.hasActiveRunMock.mockReturnValue(false);
    mocks.scheduledHasRunningMock.mockReturnValue(false);
    mocks.listMemoriesMock.mockResolvedValue([]);
    mocks.listRuntimeStatesMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.RAILWAY_TOKEN;
    delete process.env.RAILWAY_API_TOKEN;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("preflights all active Topics before deleting any history", async () => {
    const inactive = { ...binding, threadId: 8, sessionId: "ses_inactive" };
    mocks.listBindingsMock.mockResolvedValue([inactive, binding]);
    mocks.hasActiveRunMock.mockImplementation((sessionId: string) => sessionId === "ses_test");

    const result = await resetHistory({} as Api, 5);

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(0);
    expect(mocks.deleteTopicMock).not.toHaveBeenCalled();
    expect(mocks.reconcileWorkspacesMock).not.toHaveBeenCalled();
    expect(mocks.clearRuntimeStatesMock).not.toHaveBeenCalled();
    expect(mocks.clearSessionDirectoryCacheMock).not.toHaveBeenCalled();
    expect(mocks.promptQueueClearAllMock).not.toHaveBeenCalled();
    expect(mocks.promptAttachmentClearAllMock).not.toHaveBeenCalled();
    expect(mocks.clearInteractionsMock).not.toHaveBeenCalled();
    expect(mocks.detachMock).not.toHaveBeenCalled();
    expect(mocks.clearAllMemoriesMock).not.toHaveBeenCalled();
    expect(mocks.assistantClearAllMock).not.toHaveBeenCalled();
    expect(mocks.foregroundClearAllMock).not.toHaveBeenCalled();
    expect(mocks.rustDeskClearAllMock).not.toHaveBeenCalled();
    expect(mocks.toolActivityClearAllMock).not.toHaveBeenCalled();
  });
  it("flushes the session-directory cache update before reporting history reset success", async () => {
    const result = await resetHistory({} as Api, 5);

    expect(result.failed).toBe(0);
    expect(mocks.clearSessionDirectoryCacheMock).toHaveBeenCalledTimes(1);
    expect(mocks.flushSettingsMock).toHaveBeenCalledTimes(1);
  });

  it("fails history verification when a managed workspace remains in a legacy root", async () => {
    const legacyRoot = `${tempRoot}-legacy`;
    const leftover = path.join(legacyRoot, "5", "leftover-session");
    await fs.mkdir(leftover, { recursive: true });
    mocks.workspaceRootsMock.mockReturnValue([tempRoot, legacyRoot]);

    try {
      const result = await resetHistory({} as Api, 5);

      expect(result.failed).toBe(1);
    } finally {
      await fs.rm(legacyRoot, { recursive: true, force: true });
    }
  });

  it("aborts factory reset before deleting Topics while a scheduled task is running", async () => {
    mocks.listBindingsMock.mockResolvedValue([binding]);
    mocks.scheduledHasRunningMock.mockReturnValue(true);

    const result = await factoryReset({} as Api, 5);

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(0);
    expect(mocks.deleteTopicMock).not.toHaveBeenCalled();
    expect(mocks.flushAppStateMock).not.toHaveBeenCalled();
    expect(mocks.scheduledClearAllMock).not.toHaveBeenCalled();
  });

  it("does not clear global runtime state when the final scheduled-runtime guard refuses reset", async () => {
    mocks.scheduledClearAllMock.mockReturnValueOnce(false);

    const result = await factoryReset({} as Api, 5);

    expect(result.failed).toBe(1);
    expect(mocks.scheduledClearAllMock).toHaveBeenCalledWith("factory_reset");
    expect(mocks.clearRuntimeStatesMock).not.toHaveBeenCalled();
    expect(mocks.promptQueueClearAllMock).not.toHaveBeenCalled();
    expect(mocks.assistantClearAllMock).not.toHaveBeenCalled();
    expect(mocks.flushAppStateMock).not.toHaveBeenCalled();
  });

  it("fails factory verification on a non-not-found OpenCode lookup error", async () => {
    mocks.listBindingsMock.mockResolvedValueOnce([binding]).mockResolvedValue([]);
    mocks.sessionGetMock.mockResolvedValue({
      data: undefined,
      error: { name: "ServerError", data: { message: "OpenCode unavailable" } },
    });

    const result = await factoryReset({} as Api, 5);

    expect(result.failed).toBe(1);
    expect(mocks.flushAppStateMock).not.toHaveBeenCalled();
    expect(mocks.resetSettingsMock).not.toHaveBeenCalled();
    expect(mocks.clearGithubTokenMock).not.toHaveBeenCalled();
    expect(mocks.clearRailwayTokenMock).not.toHaveBeenCalled();
  });

  it("clears all integration runtime credentials on a successful factory reset", async () => {
    process.env.GITHUB_TOKEN = "github-a";
    process.env.GH_TOKEN = "github-b";
    process.env.RAILWAY_TOKEN = "railway-a";
    process.env.RAILWAY_API_TOKEN = "railway-b";

    const result = await factoryReset({} as Api, 5);

    expect(result.failed).toBe(0);
    expect(mocks.scheduledClearAllMock).toHaveBeenCalledWith("factory_reset");
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(process.env.RAILWAY_TOKEN).toBeUndefined();
    expect(process.env.RAILWAY_API_TOKEN).toBeUndefined();
  });
});

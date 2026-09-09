import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  opencodeClient: {
    session: {
      messages: vi.fn(),
      diff: vi.fn(),
    },
  },
  getStoredModel: vi.fn(),
  getModelContextLimit: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({ opencodeClient: mocked.opencodeClient }));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({ getStoredModel: mocked.getStoredModel }));
vi.mock("../../../src/app/services/model-context-limit-service.js", () => ({
  DEFAULT_CONTEXT_LIMIT: 204800,
  getModelContextLimit: mocked.getModelContextLimit,
}));
vi.mock("../../../src/i18n/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/i18n/index.js")>();
  return {
    ...actual,
    t: (key: string) => {
      if (key === "pinned.default_session_title") return "new session";
      return key;
    },
  };
});

// Must import AFTER vi.mock calls
const { pinnedMessageManager } = await import("../../../src/bot/pinned/pinned-message-manager.js");

describe("pinned/manager", () => {
  let fakeApi: {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    pinChatMessage: ReturnType<typeof vi.fn>;
    unpinAllChatMessages: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    fakeApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      pinChatMessage: vi.fn().mockResolvedValue(undefined),
      unpinAllChatMessages: vi.fn().mockResolvedValue(undefined),
    };

    pinnedMessageManager.initialize(fakeApi as never, 123);

    mocked.getStoredModel.mockReturnValue({ providerID: "openai", modelID: "gpt-5" });
    mocked.getModelContextLimit.mockResolvedValue(204800);
    mocked.opencodeClient.session.messages.mockResolvedValue({ data: [] });
    mocked.opencodeClient.session.diff.mockResolvedValue({ data: [] });
  });

  describe("loadContextFromHistory", () => {
    it("restores tokens and cost from the last assistant message in history", async () => {
      mocked.opencodeClient.session.messages.mockResolvedValue({
        data: [
          {
            info: {
              role: "assistant",
              time: { created: 100 },
              tokens: { input: 900, cache: { read: 100 } },
              cost: 0.25,
            },
            parts: [],
          },
          {
            info: {
              role: "assistant",
              summary: true,
              time: { created: 200 },
              tokens: { input: 1500, cache: { read: 0 } },
              cost: 4,
            },
            parts: [],
          },
          {
            info: {
              role: "assistant",
              time: { created: 300 },
              tokens: { input: 300, cache: { read: 100 } },
              cost: 0.5,
            },
            parts: [],
          },
        ],
      });

      await pinnedMessageManager.loadContextFromHistory("ses-1", "D:/repo");

      const state = pinnedMessageManager.getState();
      expect(state.tokensUsed).toBe(400);
      expect(state.cost).toBe(0.5);
      expect(state.sessionId).toBe("ses-1");
    });
  });

  describe("updateTokensSilent", () => {
    it("updates tokensUsed from input plus cacheRead without any API call", () => {
      pinnedMessageManager.updateTokensSilent({
        input: 5000,
        output: 200,
        reasoning: 0,
        cacheRead: 1000,
        cacheWrite: 0,
      });

      expect(pinnedMessageManager.getState().tokensUsed).toBe(6000);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
      expect(fakeApi.sendMessage).not.toHaveBeenCalled();
    });

    it("reflects the latest values rather than accumulating", () => {
      pinnedMessageManager.updateTokensSilent({
        input: 500,
        output: 100,
        reasoning: 0,
        cacheRead: 100,
        cacheWrite: 0,
      });
      pinnedMessageManager.updateTokensSilent({
        input: 5000,
        output: 200,
        reasoning: 0,
        cacheRead: 1000,
        cacheWrite: 0,
      });

      expect(pinnedMessageManager.getState().tokensUsed).toBe(6000);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });
  });

  describe("refresh", () => {
    it("re-reads the context limit from the stored model", async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");
      mocked.getModelContextLimit.mockResolvedValue(1_000_000);

      await pinnedMessageManager.refresh();

      expect(pinnedMessageManager.getContextLimit()).toBe(1_000_000);
    });

    it("does not throw when no pinned message exists", async () => {
      await expect(pinnedMessageManager.refresh()).resolves.not.toThrow();
    });

    it("does not touch the Telegram API", async () => {
      await pinnedMessageManager.refresh();

      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
      expect(fakeApi.sendMessage).not.toHaveBeenCalled();
      expect(fakeApi.pinChatMessage).not.toHaveBeenCalled();
      expect(fakeApi.unpinAllChatMessages).not.toHaveBeenCalled();
    });
  });

  describe("session state", () => {
    it("stores the session id and title on session change", async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");

      expect(pinnedMessageManager.getState()).toMatchObject({
        sessionId: "ses-1",
        sessionTitle: "Test Session",
      });
    });

    it("falls back to the default title when the session title is empty", async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "");

      expect(pinnedMessageManager.getState().sessionTitle).toBe("new session");
    });

    it("resets tokens, cost and file changes on session change", async () => {
      pinnedMessageManager.updateTokensSilent({
        input: 400,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      await pinnedMessageManager.onCostUpdate(2);
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 });

      await pinnedMessageManager.onSessionChange("ses-2", "Next Session");

      expect(pinnedMessageManager.getState()).toMatchObject({
        sessionId: "ses-2",
        tokensUsed: 0,
        cost: 0,
        changedFiles: [],
      });
    });
  });

  describe("setOnKeyboardUpdate race condition fix", () => {
    it("fires callback immediately with current state when contextLimit is known", async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");

      const callback = vi.fn();
      pinnedMessageManager.setOnKeyboardUpdate(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(0, 204800);
    });

    it("fires callback with updated tokens after silent update", async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");

      pinnedMessageManager.updateTokensSilent({
        input: 3000,
        output: 100,
        reasoning: 0,
        cacheRead: 500,
        cacheWrite: 0,
      });

      const callback = vi.fn();
      pinnedMessageManager.setOnKeyboardUpdate(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(3500, 204800);
    });
  });

  describe("addFileChange", () => {
    it("records each distinct file change without any API call", () => {
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 });
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/b.ts", additions: 2, deletions: 1 });
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/c.ts", additions: 3, deletions: 0 });

      expect(pinnedMessageManager.getState().changedFiles).toEqual([
        { file: "D:/repo/src/a.ts", additions: 1, deletions: 0 },
        { file: "D:/repo/src/b.ts", additions: 2, deletions: 1 },
        { file: "D:/repo/src/c.ts", additions: 3, deletions: 0 },
      ]);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });

    it("accumulates additions and deletions for the same file", () => {
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/a.ts", additions: 1, deletions: 2 });
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/a.ts", additions: 4, deletions: 1 });

      expect(pinnedMessageManager.getState().changedFiles).toEqual([
        { file: "D:/repo/src/a.ts", additions: 5, deletions: 3 },
      ]);
    });

    it("does not touch the Telegram API when recording file changes", () => {
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 });
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/b.ts", additions: 1, deletions: 0 });

      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
      expect(fakeApi.sendMessage).not.toHaveBeenCalled();
    });

    it("merges into diffs stored by onSessionDiff", async () => {
      await pinnedMessageManager.onSessionDiff([{ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 }]);
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/a.ts", additions: 2, deletions: 1 });

      expect(pinnedMessageManager.getState().changedFiles).toEqual([
        { file: "D:/repo/src/a.ts", additions: 3, deletions: 1 },
      ]);
    });
  });

  describe("cost and token updates", () => {
    beforeEach(async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");
      fakeApi.editMessageText.mockClear();
    });

    it("accumulates finite cost updates", async () => {
      await pinnedMessageManager.onCostUpdate(1);
      await pinnedMessageManager.onCostUpdate(2);
      await pinnedMessageManager.onCostUpdate(3);

      expect(pinnedMessageManager.getState().cost).toBe(6);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });

    it("ignores non-finite cost updates", async () => {
      await pinnedMessageManager.onCostUpdate(5);
      await pinnedMessageManager.onCostUpdate(Number.NaN);

      expect(pinnedMessageManager.getState().cost).toBe(5);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });

    it("applies the latest token totals on message completion", async () => {
      await pinnedMessageManager.onMessageComplete({
        input: 100,
        output: 10,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      await pinnedMessageManager.onMessageComplete({
        input: 150,
        output: 10,
        reasoning: 0,
        cacheRead: 50,
        cacheWrite: 0,
      });

      expect(pinnedMessageManager.getState().tokensUsed).toBe(200);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });
  });

  describe("message completion without rendering", () => {
    const tokens = { input: 100, output: 10, reasoning: 0, cacheRead: 10, cacheWrite: 0 };

    beforeEach(async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");
    });

    it("does not call the Telegram API when a message completes", async () => {
      await pinnedMessageManager.onMessageComplete(tokens);

      expect(pinnedMessageManager.getState().tokensUsed).toBe(110);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
      expect(fakeApi.sendMessage).not.toHaveBeenCalled();
    });

    it("treats repeated identical completions as idempotent state updates", async () => {
      await pinnedMessageManager.onMessageComplete(tokens);
      await pinnedMessageManager.onMessageComplete(tokens);

      expect(pinnedMessageManager.getState().tokensUsed).toBe(110);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });

    it("does not unpin or recreate the message when a message completes", async () => {
      await pinnedMessageManager.onMessageComplete(tokens);

      expect(fakeApi.pinChatMessage).not.toHaveBeenCalled();
      expect(fakeApi.unpinAllChatMessages).not.toHaveBeenCalled();
      expect(pinnedMessageManager.getState().messageId).toBeNull();
    });
  });

  describe("loading file diffs on session change", () => {
    beforeEach(async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");
    });

    it("does not call the diff or message APIs on session change", () => {
      expect(mocked.opencodeClient.session.diff).not.toHaveBeenCalled();
      expect(mocked.opencodeClient.session.messages).not.toHaveBeenCalled();
    });

    it("clears previously collected file changes on session change", async () => {
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 });

      await pinnedMessageManager.onSessionChange("ses-2", "Next Session");

      expect(pinnedMessageManager.getState().changedFiles).toEqual([]);
    });

    it("does not restore tokens from history automatically", async () => {
      mocked.opencodeClient.session.messages.mockResolvedValue({
        data: [
          {
            info: {
              role: "assistant",
              time: { created: 100 },
              tokens: { input: 900, cache: { read: 100 } },
              cost: 0.25,
            },
            parts: [],
          },
        ],
      });

      await pinnedMessageManager.onSessionChange("ses-2", "Next Session");

      expect(mocked.opencodeClient.session.messages).not.toHaveBeenCalled();
      expect(pinnedMessageManager.getState().tokensUsed).toBe(0);
    });

    it("loads context on demand with the requested directory", async () => {
      await pinnedMessageManager.loadContextFromHistory("ses-1", "D:/repo");

      expect(mocked.opencodeClient.session.messages).toHaveBeenCalledTimes(1);
      expect(mocked.opencodeClient.session.messages).toHaveBeenCalledWith({
        sessionID: "ses-1",
        directory: "D:/repo",
      });
    });
  });

  describe("onSessionDiff", () => {
    it("replaces the changed files with the supplied diff", async () => {
      await pinnedMessageManager.onSessionDiff([
        { file: "D:/repo/src/a.ts", additions: 1, deletions: 0 },
        { file: "D:/repo/src/b.ts", additions: 2, deletions: 0 },
      ]);

      expect(pinnedMessageManager.getState().changedFiles).toEqual([
        { file: "D:/repo/src/a.ts", additions: 1, deletions: 0 },
        { file: "D:/repo/src/b.ts", additions: 2, deletions: 0 },
      ]);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });

    it("applies a diff that drops one of the changed files", async () => {
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 });
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/b.ts", additions: 2, deletions: 0 });

      await pinnedMessageManager.onSessionDiff([{ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 }]);

      expect(pinnedMessageManager.getState().changedFiles).toEqual([
        { file: "D:/repo/src/a.ts", additions: 1, deletions: 0 },
      ]);
    });

    it("applies a diff that changes the line counts of the same file", async () => {
      await pinnedMessageManager.onSessionDiff([{ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 }]);
      await pinnedMessageManager.onSessionDiff([{ file: "D:/repo/src/a.ts", additions: 2, deletions: 0 }]);

      expect(pinnedMessageManager.getState().changedFiles).toEqual([
        { file: "D:/repo/src/a.ts", additions: 2, deletions: 0 },
      ]);
    });

    it("does not touch the Telegram API when applying a diff", async () => {
      await pinnedMessageManager.onSessionDiff([{ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 }]);

      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
      expect(fakeApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("restoreExistingSession", () => {
    it("stores the restored session without creating a new message", async () => {
      await pinnedMessageManager.restoreExistingSession("ses-1", "Restored session");

      expect(fakeApi.sendMessage).not.toHaveBeenCalled();
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
      expect(pinnedMessageManager.getState()).toMatchObject({
        sessionId: "ses-1",
        sessionTitle: "Restored session",
      });
    });

    it("does not load file diffs from the API", async () => {
      await pinnedMessageManager.restoreExistingSession("ses-1", "Restored session");

      expect(mocked.opencodeClient.session.diff).not.toHaveBeenCalled();
      expect(mocked.opencodeClient.session.messages).not.toHaveBeenCalled();
      expect(pinnedMessageManager.getState().changedFiles).toEqual([]);
    });
  });

  describe("context limit", () => {
    it("defaults to the configured limit before any session activity", () => {
      pinnedMessageManager.__resetForTests();

      expect(pinnedMessageManager.getContextInfo()).toEqual({ tokensUsed: 0, tokensLimit: 204800 });
      expect(pinnedMessageManager.getContextLimit()).toBe(204800);
    });

    it("resolves the limit from the stored model on session change", async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");

      expect(mocked.getModelContextLimit).toHaveBeenCalledTimes(1);
      expect(mocked.getModelContextLimit).toHaveBeenCalledWith("openai", "gpt-5");
      expect(pinnedMessageManager.getContextLimit()).toBe(204800);
    });

    it("re-reads the limit after a model change", async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");
      mocked.getModelContextLimit.mockResolvedValue(1_000_000);

      await pinnedMessageManager.refreshContextLimit();

      expect(pinnedMessageManager.getContextLimit()).toBe(1_000_000);
    });

    it("falls back to the default limit when the model lookup fails", async () => {
      mocked.getModelContextLimit.mockRejectedValue(new Error("model registry unavailable"));

      await pinnedMessageManager.refreshContextLimit();

      expect(pinnedMessageManager.getContextLimit()).toBe(204800);
    });
  });

  describe("incremental state updates", () => {
    beforeEach(async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");
      fakeApi.editMessageText.mockClear();
    });

    it("updates the session title only for a non-empty title", async () => {
      await pinnedMessageManager.onSessionTitleUpdate("Renamed session");
      await pinnedMessageManager.onSessionTitleUpdate("");

      expect(pinnedMessageManager.getState().sessionTitle).toBe("Renamed session");
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });

    it("drops the busy flag as soon as the session is detached", async () => {
      await pinnedMessageManager.setAttachState(true, true);
      expect(pinnedMessageManager.getState()).toMatchObject({
        attachActive: true,
        attachBusy: true,
      });

      await pinnedMessageManager.setAttachState(false, true);

      expect(pinnedMessageManager.getState()).toMatchObject({
        attachActive: false,
        attachBusy: false,
      });
    });

    it("ignores cost updates that cannot change the total", async () => {
      await pinnedMessageManager.onCostUpdate(0);
      await pinnedMessageManager.onCostUpdate(Number.NaN);

      expect(pinnedMessageManager.getState().cost).toBe(0);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });

    it("reloads context from history after a compaction", async () => {
      mocked.opencodeClient.session.messages.mockResolvedValue({
        data: [
          {
            info: {
              role: "assistant",
              time: { created: 100 },
              tokens: { input: 700, cache: { read: 300 } },
              cost: 0.3,
            },
            parts: [],
          },
        ],
      });

      await pinnedMessageManager.onSessionCompacted("ses-1", "D:/repo");

      expect(pinnedMessageManager.getState().tokensUsed).toBe(1000);
      expect(pinnedMessageManager.getState().cost).toBe(0.3);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });

    it("keeps the current context when the history request fails", async () => {
      pinnedMessageManager.updateTokensSilent({
        input: 400,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      mocked.opencodeClient.session.messages.mockResolvedValue({ error: { message: "boom" } });

      await pinnedMessageManager.loadContextFromHistory("ses-1", "D:/repo");

      expect(pinnedMessageManager.getState().tokensUsed).toBe(400);
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
    });

    it("notifies the keyboard callback when tokens change but not on silent updates", async () => {
      const callback = vi.fn();
      pinnedMessageManager.setOnKeyboardUpdate(callback);
      callback.mockClear();

      pinnedMessageManager.updateTokensSilent({
        input: 400,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(callback).not.toHaveBeenCalled();

      await pinnedMessageManager.onMessageComplete({
        input: 100,
        output: 0,
        reasoning: 0,
        cacheRead: 50,
        cacheWrite: 0,
      });

      expect(callback).toHaveBeenCalledWith(150, 204800);
    });
  });

  describe("changed files state", () => {
    it("stores more than ten file changes without truncation", async () => {
      await pinnedMessageManager.onSessionDiff(
        Array.from({ length: 12 }, (_, index) => ({
          file: `D:/repo/src/file-${index}.ts`,
          additions: 1,
          deletions: 0,
        })),
      );

      const changedFiles = pinnedMessageManager.getState().changedFiles;
      expect(changedFiles).toHaveLength(12);
      expect(changedFiles[11]?.file).toBe("D:/repo/src/file-11.ts");
    });

    it("keeps the original file paths as supplied", async () => {
      await pinnedMessageManager.onSessionDiff([
        { file: "C:/other/deep/nested/path/file.ts", additions: 1, deletions: 0 },
      ]);

      expect(pinnedMessageManager.getState().changedFiles).toEqual([
        { file: "C:/other/deep/nested/path/file.ts", additions: 1, deletions: 0 },
      ]);
    });
  });

  describe("clear", () => {
    it("drops the session state and cost without touching Telegram", async () => {
      await pinnedMessageManager.onSessionChange("ses-1", "Test Session");
      pinnedMessageManager.updateTokensSilent({
        input: 400,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      pinnedMessageManager.addFileChange({ file: "D:/repo/src/a.ts", additions: 1, deletions: 0 });
      await pinnedMessageManager.onCostUpdate(2);
      await pinnedMessageManager.setAttachState(true, true);

      await pinnedMessageManager.clear();

      expect(fakeApi.unpinAllChatMessages).not.toHaveBeenCalled();
      expect(fakeApi.editMessageText).not.toHaveBeenCalled();
      expect(pinnedMessageManager.getState()).toMatchObject({
        messageId: null,
        sessionId: null,
        sessionTitle: "new session",
        attachActive: false,
        attachBusy: false,
        tokensUsed: 0,
        changedFiles: [],
        cost: 0,
      });
    });

    it("resets state without touching Telegram when not initialized", async () => {
      pinnedMessageManager.__resetForTests();

      await pinnedMessageManager.clear();

      expect(pinnedMessageManager.isInitialized()).toBe(false);
      expect(fakeApi.unpinAllChatMessages).not.toHaveBeenCalled();
      expect(fakeApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("per-Topic context accounting", () => {
    it("keeps token counters isolated per session scope", async () => {
      const { runInTopicRuntimeContext } = await import("../../../src/app/services/topic-runtime-context.js");
      pinnedMessageManager.__resetForTests();
      pinnedMessageManager.initialize(fakeApi as never, 123);

      await pinnedMessageManager.onSessionChange("ses-a", "Topic A");
      pinnedMessageManager.updateTokensSilent({ input: 100, output: 1, reasoning: 0, cacheRead: 20, cacheWrite: 0 });
      await pinnedMessageManager.onSessionChange("ses-b", "Topic B");
      pinnedMessageManager.updateTokensSilent({ input: 500, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 });

      // The unscoped (main) reader resolves to the most recent focus session.
      expect(pinnedMessageManager.getContextInfo().tokensUsed).toBe(500);

      // Topic A's own runtime context still sees its own accounting untouched.
      const scopedA = runInTopicRuntimeContext({ chatId: 123, threadId: 11, sessionId: "ses-a" }, () => pinnedMessageManager.getContextInfo());
      expect(scopedA.tokensUsed).toBe(120);
    });

    it("clears only the current Topic scope, not other sessions", async () => {
      const { runInTopicRuntimeContext } = await import("../../../src/app/services/topic-runtime-context.js");
      await pinnedMessageManager.onSessionChange("ses-c", "Topic C");
      pinnedMessageManager.updateTokensSilent({ input: 900, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 });

      await runInTopicRuntimeContext({ chatId: 123, threadId: 12, sessionId: "ses-d" }, async () => {
        await pinnedMessageManager.clear();
        expect(pinnedMessageManager.getContextInfo().tokensUsed).toBe(0);
      });

      const stillIntact = runInTopicRuntimeContext({ chatId: 123, threadId: 11, sessionId: "ses-c" }, () => pinnedMessageManager.getContextInfo());
      expect(stillIntact.tokensUsed).toBe(900);
      pinnedMessageManager.__resetForTests();
    });
  });
});

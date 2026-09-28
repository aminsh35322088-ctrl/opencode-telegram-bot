import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocked = vi.hoisted(() => ({
  resume: vi.fn(),
  cancelPending: vi.fn(),
  questionReply: vi.fn(),
  questionReject: vi.fn(),
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: vi.fn(() => ({
    id: "ses-extension",
    title: "Telegram Topic",
    directory: "/work/repo",
  })),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: vi.fn(() => ({ worktree: "/work/repo" })),
}));

vi.mock("../../../src/app/services/extension-ensure-service.js", () => ({
  resumePendingExtensionAddFromQuestion: mocked.resume,
  cancelPendingExtensionAddForQuestion: mocked.cancelPending,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    question: {
      reply: mocked.questionReply,
      reject: mocked.questionReject,
    },
  },
}));

vi.mock("../../../src/app/managers/summary-aggregation-manager.js", () => ({
  summaryAggregator: {
    clear: vi.fn(),
    stopTypingIndicator: vi.fn(),
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../../src/utils/safe-background-task.js", () => ({
  safeBackgroundTask: (options: {
    task: () => Promise<unknown>;
    onSuccess?: (value: unknown) => void;
  }) => {
    void options.task().then((value) => options.onSuccess?.(value));
  },
}));

import { questionManager } from "../../../src/app/managers/question-manager.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { handleQuestionCallback } from "../../../src/bot/callbacks/question-callback-handler.js";

function context(): Context {
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };
  return {
    chat: { id: 123 },
    callbackQuery: {
      data: "question:select:0:0",
      message: { message_id: 100 },
    } as Context["callbackQuery"],
    api: api as unknown as Context["api"],
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("Question-driven Skill resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    questionManager.clearAll();
    interactionManager.clearAll();
    mocked.questionReply.mockResolvedValue({ data: true, error: undefined });
    mocked.questionReject.mockResolvedValue({ data: true, error: undefined });
    mocked.cancelPending.mockReturnValue(false);
    mocked.resume.mockResolvedValue({
      handled: true,
      status: "resumed",
      intent: {
        sessionId: "ses-extension",
        projectDirectory: "/work/repo",
        kind: "skill",
        source: "https://github.com/example/skills/tree/main/deploy-check",
        name: "deploy-check",
        purpose: "Install deploy-check",
        question: { header: "Add Skill", question: "Add deploy-check?" },
        choices: [{ label: "Add", action: "add" }],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      result: {
        status: "ready",
        extension: {
          id: "skill:deploy-check",
          name: "deploy-check",
          kind: "skill",
          source: "https://github.com/example/skills/tree/main/deploy-check",
          purpose: "Deployment checks",
          authType: "none",
          credentialSchemas: [],
          resource: { kind: "skill", skillName: "deploy-check" },
          createdAt: "2026-09-28T00:00:00.000Z",
          updatedAt: "2026-09-28T00:00:00.000Z",
          managed: true,
        },
      },
    });
  });

  it("resumes the pending Skill directly after Add is selected", async () => {
    questionManager.startQuestions([{
      header: "Add Skill",
      question: "Add deploy-check?",
      options: [{
        label: "Add",
        description: "Install the detected Skill.",
      }],
      multiple: false,
    }], "req-extension");
    questionManager.setChatId(123);
    questionManager.setActiveMessageId(100);

    const ctx = context();
    await expect(handleQuestionCallback(ctx)).resolves.toBe(true);

    expect(mocked.resume).toHaveBeenCalledWith({
      sessionId: "ses-extension",
      questions: [{
        header: "Add Skill",
        question: "Add deploy-check?",
      }],
      answers: [["* Add: Install the detected Skill."]],
    });
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      123,
      "✅ deploy-check added. Its Actions were synchronized automatically.",
    );
    await vi.waitFor(() => {
      expect(mocked.questionReply).toHaveBeenCalledWith({
        requestID: "req-extension",
        directory: "/work/repo",
        answers: [["* Add: Install the detected Skill."]],
      });
    });
    expect(questionManager.isActive()).toBe(false);
  });
});

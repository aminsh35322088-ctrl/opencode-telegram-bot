import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocked = vi.hoisted(() => ({
  resume: vi.fn(),
  cancelPending: vi.fn(),
  presentAutomation: vi.fn(),
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

vi.mock("../../../src/bot/services/extension-automation-ui.js", () => ({
  presentPendingExtensionAutomation: mocked.presentAutomation,
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

describe("Question-driven Extension resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    questionManager.clearAll();
    interactionManager.clearAll();
    mocked.questionReply.mockResolvedValue({ data: true, error: undefined });
    mocked.questionReject.mockResolvedValue({ data: true, error: undefined });
    mocked.presentAutomation.mockResolvedValue(true);
    mocked.cancelPending.mockReturnValue(false);
    mocked.resume.mockResolvedValue({
      handled: true,
      status: "resumed",
      intent: {
        sessionId: "ses-extension",
        projectDirectory: "/work/repo",
        kind: "mcp",
        source: "https://api.graphify.com/mcp",
        name: "graphify",
        purpose: "Repository graph analysis",
        question: {
          header: "Add MCP Server",
          question: "Add graphify to the bot?",
        },
        choices: [{ label: "Add", action: "add" }],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      result: {
        status: "awaiting-oauth",
        extension: {
          id: "mcp:graphify",
          name: "graphify",
          kind: "mcp",
          source: "https://api.graphify.com/mcp",
          purpose: "Repository graph analysis",
          authType: "oauth",
          credentialSchemas: [],
          resource: {
            kind: "mcp",
            serverName: "graphify",
            projectDirectory: "/work/repo",
          },
          createdAt: "2026-09-28T00:00:00.000Z",
          updatedAt: "2026-09-28T00:00:00.000Z",
          managed: true,
        },
        authorizationUrl: "https://graphify.example/oauth/authorize",
        oauthState: "oauth-state",
      },
    });
  });

  it("resumes the pending add directly after Add is selected", async () => {
    questionManager.startQuestions([{
      header: "Add MCP Server",
      question: "Add graphify to the bot?",
      options: [{
        label: "Add",
        description: "Use OpenCode automatic MCP authentication discovery.",
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
        header: "Add MCP Server",
        question: "Add graphify to the bot?",
      }],
      answers: [[
        "* Add: Use OpenCode automatic MCP authentication discovery.",
      ]],
    });
    expect(mocked.presentAutomation).toHaveBeenCalledWith(
      ctx.api,
      123,
      "ses-extension",
    );
    await vi.waitFor(() => {
      expect(mocked.questionReply).toHaveBeenCalledWith({
        requestID: "req-extension",
        directory: "/work/repo",
        answers: [[
          "* Add: Use OpenCode automatic MCP authentication discovery.",
        ]],
      });
    });
    expect(questionManager.isActive()).toBe(false);
  });
});

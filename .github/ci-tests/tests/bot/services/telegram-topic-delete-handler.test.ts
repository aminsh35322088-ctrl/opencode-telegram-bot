import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasActiveRunMock: vi.fn(() => false),
  findBindingMock: vi.fn(),
  deleteTopicMock: vi.fn(),
  getCurrentSessionMock: vi.fn(() => undefined),
  detachMock: vi.fn(),
  clearInteractionsMock: vi.fn(),
  abortMock: vi.fn(),
}));

vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({
  assistantRunState: { hasActiveRun: mocks.hasActiveRunMock },
}));
vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({
  findTelegramTopicBindingByThread: mocks.findBindingMock,
}));
vi.mock("../../../src/app/services/telegram-topic-delete-service.js", () => ({
  deleteTelegramTopicSession: mocks.deleteTopicMock,
}));
vi.mock("../../../src/app/managers/interaction-manager.js", () => ({
  interactionManager: { clear: vi.fn(), clearAll: vi.fn() },
  clearAllInteractionState: mocks.clearInteractionsMock,
}));
vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: mocks.getCurrentSessionMock,
}));
vi.mock("../../../src/app/services/attach-service.js", () => ({
  detachAttachedSession: mocks.detachMock,
}));
vi.mock("../../../src/bot/commands/abort-command.js", () => ({
  abortCurrentOperation: mocks.abortMock,
}));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleTelegramTopicDeleteCallback } from "../../../src/bot/services/telegram-topic-delete-handler.js";

const binding = {
  chatId: 5,
  threadId: 7,
  sessionId: "ses_test",
  directory: "/data/opencode/topic-workspaces/5/workspace",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
describe("telegram-topic-delete-handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasActiveRunMock.mockReturnValue(false);
    mocks.findBindingMock.mockResolvedValue(binding);
    mocks.deleteTopicMock.mockRejectedValue(
      new AggregateError([new Error("session service unavailable")], "binding retained for retry"),
    );
  });

  it("reports a retry-safe incomplete cleanup without claiming the Telegram Topic was removed", async () => {
    const editMessageText = vi.fn(async () => ({}));
    const ctx = {
      callbackQuery: {
        data: "telegram-topic:delete:confirm",
        message: { chat: { id: 5 }, message_thread_id: 7 },
      },
      api: {},
      answerCallbackQuery: vi.fn(async () => ({})),
      editMessageText,
      editMessageReplyMarkup: vi.fn(async () => ({})),
    };

    await expect(handleTelegramTopicDeleteCallback(ctx as never)).resolves.toBe(true);

    expect(editMessageText).toHaveBeenCalledTimes(1);
    const [message] = editMessageText.mock.calls[0] ?? [];
    expect(String(message)).not.toContain("Telegram Topic was removed");
    expect(String(message)).toMatch(/retry|try again/i);
  });
});

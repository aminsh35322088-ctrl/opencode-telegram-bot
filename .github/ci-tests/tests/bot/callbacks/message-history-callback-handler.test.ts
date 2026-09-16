import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { handleMessagesCallback } from "../../../src/bot/callbacks/message-history-callback-handler.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  revertMock: vi.fn(),
  unrevertMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      revert: mocked.revertMock,
      unrevert: mocked.unrevertMock,
      fork: vi.fn(),
    },
  },
}));

vi.mock("../../../src/app/services/run-control-service.js", () => ({
  isForegroundBusy: vi.fn(() => false),
}));

function createCallbackContext(data: string, messageId: number): Context {
  return {
    chat: { id: 777 },
    callbackQuery: {
      data,
      message: { message_id: messageId },
    } as Context["callbackQuery"],
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

function createDeps() {
  return {
    bot: {} as Bot<Context>,
    ensureEventSubscription: vi.fn().mockResolvedValue(undefined),
  };
}

function startDetailInteraction(messageId = 500): void {
  interactionManager.start({
    kind: "custom",
    expectedInput: "callback",
    metadata: {
      flow: "messages",
      stage: "detail",
      messageId,
      projectDirectory: "/workspace/repo",
      sessionId: "session-1",
      messages: [
        {
          id: "message-1",
          text: "Refactor the service",
          created: Date.UTC(2026, 8, 14, 12, 0, 0),
        },
      ],
      page: 0,
      selectedIndex: 0,
    },
  });
}

function getCallbackData(button: unknown): string | undefined {
  if (!button || typeof button !== "object") return undefined;
  return (button as { callback_data?: string }).callback_data;
}

describe("message history revert/redo callbacks", () => {
  beforeEach(() => {
    interactionManager.clear("test_setup");
    mocked.revertMock.mockReset();
    mocked.unrevertMock.mockReset();
    mocked.revertMock.mockResolvedValue({ data: {}, error: null });
    mocked.unrevertMock.mockResolvedValue({ data: {}, error: null });
  });

  it("keeps message interaction active after revert and exposes native redo", async () => {
    startDetailInteraction();
    const ctx = createCallbackContext("messages:revert", 500);

    const handled = await handleMessagesCallback(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.revertMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/workspace/repo",
      messageID: "message-1",
    });

    const editMock = ctx.editMessageText as unknown as ReturnType<typeof vi.fn>;
    expect(editMock).toHaveBeenCalledTimes(1);
    const [, options] = editMock.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: unknown[][] } },
    ];
    expect(
      options.reply_markup.inline_keyboard.flat().some((button) => getCallbackData(button) === "messages:redo"),
    ).toBe(true);

    const state = interactionManager.getSnapshot();
    expect(state?.kind).toBe("custom");
    expect(state?.metadata.flow).toBe("messages");
    expect(state?.metadata.stage).toBe("detail");
    expect(state?.metadata.selectedIndex).toBe(0);
  });

  it("uses OpenCode unrevert for redo and restores the detail actions", async () => {
    startDetailInteraction();
    const ctx = createCallbackContext("messages:redo", 500);

    const handled = await handleMessagesCallback(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.unrevertMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/workspace/repo",
    });

    const editMock = ctx.editMessageText as unknown as ReturnType<typeof vi.fn>;
    expect(editMock).toHaveBeenCalledTimes(1);
    const [, options] = editMock.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: unknown[][] } },
    ];
    const callbackData = options.reply_markup.inline_keyboard.flat().map(getCallbackData);
    expect(callbackData).toContain("messages:revert");
    expect(callbackData).toContain("messages:fork");
    expect(callbackData).not.toContain("messages:redo");

    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("detail");
  });

  it("keeps redo available when unrevert fails", async () => {
    mocked.unrevertMock.mockResolvedValue({
      data: undefined,
      error: new Error("unrevert failed"),
    });
    startDetailInteraction();
    const ctx = createCallbackContext("messages:redo", 500);

    const handled = await handleMessagesCallback(ctx, createDeps());

    expect(handled).toBe(true);
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("detail");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("messages.redo_error"),
      show_alert: true,
    });
  });
});

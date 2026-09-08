import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const { downloadTelegramFileMock, promptAttachmentSetMock } = vi.hoisted(() => ({
  downloadTelegramFileMock: vi.fn(async () => ({ buffer: Buffer.from("x"), mimeType: "image/jpeg" })),
  promptAttachmentSetMock: vi.fn(),
}));

vi.mock("../../../src/app/services/file-download-service.js", () => ({
  downloadTelegramFile: downloadTelegramFileMock,
}));

vi.mock("../../../src/app/managers/prompt-attachment-manager.js", () => ({
  promptAttachment: { set: promptAttachmentSetMock },
}));

import { enrichTelegramReplyContext } from "../../../src/app/services/telegram-reply-context-service.js";

function contextWithReply(text: string): Context {
  return {
    message: {
      text,
      reply_to_message: { message_id: 10, from: { first_name: "Chat Bot" }, text: "previous answer" },
    },
  } as unknown as Context;
}

describe("enrichTelegramReplyContext", () => {
  it("does not rewrite a slash command sent as a reply", async () => {
    const ctx = contextWithReply("/abort");

    await enrichTelegramReplyContext(ctx, "/tmp/workspace");

    expect(ctx.message?.text).toBe("/abort");
    expect(downloadTelegramFileMock).not.toHaveBeenCalled();
  });

  it("does not rewrite a command with a bot-mention suffix", async () => {
    const ctx = contextWithReply("/pause@my_bot");

    await enrichTelegramReplyContext(ctx, "/tmp/workspace");

    expect(ctx.message?.text).toBe("/pause@my_bot");
  });

  it("still enriches an ordinary prompt sent as a reply", async () => {
    const ctx = contextWithReply("please refactor this");

    await enrichTelegramReplyContext(ctx, "/tmp/workspace");

    expect(ctx.message?.text).toContain("Replying to");
    expect(ctx.message?.text).toContain("please refactor this");
  });
});

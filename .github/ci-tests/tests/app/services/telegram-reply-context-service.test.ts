import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const {
  downloadTelegramFileMock,
  promptAttachmentSetMock,
  promptAttachmentSetManyMock,
  extractVideoFramesMock,
  extractVideoAudioMock,
  isSttConfiguredMock,
  transcribeAudioMock,
} = vi.hoisted(() => ({
  downloadTelegramFileMock: vi.fn(async () => ({ buffer: Buffer.from("x"), mimeType: "image/jpeg" })),
  promptAttachmentSetMock: vi.fn(),
  promptAttachmentSetManyMock: vi.fn(),
  extractVideoFramesMock: vi.fn(async () => [
    { filename: "frame-01.jpg", buffer: Buffer.from("f1") },
    { filename: "frame-02.jpg", buffer: Buffer.from("f2") },
  ]),
  extractVideoAudioMock: vi.fn(async () => ({ buffer: Buffer.from("audio"), filename: "audio.ogg" })),
  isSttConfiguredMock: vi.fn(async () => true),
  transcribeAudioMock: vi.fn(async () => ({ text: "transcribed speech", uncertain: false })),
}));

vi.mock("../../../src/app/services/file-download-service.js", () => ({
  downloadTelegramFile: downloadTelegramFileMock,
}));

vi.mock("../../../src/app/managers/prompt-attachment-manager.js", () => ({
  promptAttachment: { set: promptAttachmentSetMock, setMany: promptAttachmentSetManyMock, __resetForTests: vi.fn() },
}));

vi.mock("../../../src/app/services/video-preparation-service.js", () => ({
  extractVideoFrames: extractVideoFramesMock,
  extractVideoAudio: extractVideoAudioMock,
}));

vi.mock("../../../src/app/services/stt-service.js", () => ({
  isSttConfigured: isSttConfiguredMock,
  transcribeAudio: transcribeAudioMock,
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

  it("prepares replied video as multiple keyframes and includes audio transcription", async () => {
    const ctx = {
      api: {},
      message: {
        text: "what happens here?",
        reply_to_message: {
          message_id: 10,
          from: { first_name: "Chat Bot" },
          video: { file_id: "video-file", file_name: "clip.mp4" },
        },
      },
    } as unknown as Context;

    await enrichTelegramReplyContext(ctx, "/tmp/workspace");

    expect(downloadTelegramFileMock).toHaveBeenCalledWith(ctx.api, "video-file");
    expect(extractVideoFramesMock).toHaveBeenCalled();
    expect(promptAttachmentSetManyMock).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ mimeType: "image/jpeg" }),
      expect.objectContaining({ mimeType: "image/jpeg" }),
    ]));
    expect(ctx.message?.text).toContain("2 keyframes");
    expect(ctx.message?.text).toContain("transcribed speech");
  });
});
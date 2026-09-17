import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const { downloadTelegramFileMock, promptAttachmentSetMock, transcribeAudioMock, isSttConfiguredMock, extractVideoFramesMock, extractAudioMock } = vi.hoisted(() => ({
  downloadTelegramFileMock: vi.fn(),
  promptAttachmentSetMock: vi.fn(),
  transcribeAudioMock: vi.fn(),
  isSttConfiguredMock: vi.fn(),
  extractVideoFramesMock: vi.fn(),
  extractAudioMock: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  downloadTelegramFileMock.mockReset().mockImplementation(async (_api: unknown, fileId: string) => ({
    buffer: Buffer.from(fileId), mimeType: undefined, filePath: `${fileId}.bin`, fileSize: fileId.length,
  }));
  transcribeAudioMock.mockReset().mockResolvedValue({ text: "Turn left at the bridge" });
  isSttConfiguredMock.mockReset().mockResolvedValue(true);
  extractVideoFramesMock.mockReset().mockResolvedValue([
    { filename: "frame-01.jpg", buffer: Buffer.from("frame-one") },
    { filename: "frame-02.jpg", buffer: Buffer.from("frame-two") },
  ]);
  extractAudioMock.mockReset().mockResolvedValue({ filename: "audio.ogg", buffer: Buffer.from("speech") });
});

vi.mock("../../../src/app/services/stt-service.js", () => ({
  transcribeAudio: transcribeAudioMock,
  isSttConfigured: isSttConfiguredMock,
}));

vi.mock("../../../src/bot/handlers/video-handler.js", () => ({
  extractVideoFrames: extractVideoFramesMock,
  extractAudio: extractAudioMock,
}));

vi.mock("../../../src/app/services/file-download-service.js", () => ({
  downloadTelegramFile: downloadTelegramFileMock,
  toDataUri: (buffer: Buffer, mime: string) => `data:${mime};base64,${buffer.toString("base64")}`,
}));

vi.mock("../../../src/app/managers/prompt-attachment-manager.js", () => ({
  promptAttachment: { set: promptAttachmentSetMock, __resetForTests: vi.fn() },
}));

vi.mock("fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));

import * as replyContext from "../../../src/app/services/telegram-reply-context-service.js";
import { enrichTelegramReplyContext } from "../../../src/app/services/telegram-reply-context-service.js";

type PreparedReplyMedia = { fileParts: Array<{ type: string; mime: string; url: string }>; text: string };

function preparedReply(ctx: Context): PreparedReplyMedia | undefined {
  const accessor = (replyContext as unknown as {
    getPreparedReplyMedia?: (ctx: Context) => PreparedReplyMedia | undefined;
  }).getPreparedReplyMedia;
  expect(accessor, "request-scoped reply media accessor must be exported").toBeTypeOf("function");
  return accessor!(ctx);
}

function contextWithReply(text: string): Context {
  return {
    message: {
      text,
      reply_to_message: { message_id: 10, from: { first_name: "Chat Bot" }, text: "previous answer" },
    },
  } as unknown as Context;
}

describe("enrichTelegramReplyContext", () => {
  it.each(["photo", "video", "video_note", "audio", "voice"])("prepares actual forwarded %s reply content", async (kind) => {
    const ctx = contextWithReply("compare with the caption");
    Object.assign(ctx.message!.reply_to_message!, {
      text: undefined,
      caption: "Original caption",
      forward_origin: { type: "channel", date: 1, chat: { id: -100 }, message_id: 3 },
      [kind]: kind === "photo" ? [{ file_id: "small" }, { file_id: "large" }] : { file_id: kind, file_size: 100 },
    });
    await enrichTelegramReplyContext(ctx, "/tmp/workspace");
    const prepared = preparedReply(ctx)!;
    expect(ctx.message?.text).toContain("Original caption");
    expect(ctx.message?.text).toContain("compare with the caption");
    if (kind === "photo") {
      expect(prepared.fileParts).toEqual([expect.objectContaining({ mime: "image/jpeg", url: "data:image/jpeg;base64,bGFyZ2U=" })]);
    } else if (kind === "video" || kind === "video_note") {
      expect(prepared.fileParts).toHaveLength(2);
      expect(prepared.fileParts[0]?.url).toBe("data:image/jpeg;base64,ZnJhbWUtb25l");
      expect(prepared.text).toContain("Turn left at the bridge");
    } else {
      expect(prepared.text).toContain("Turn left at the bridge");
      expect(prepared.fileParts).toEqual([]);
    }
    expect(promptAttachmentSetMock).not.toHaveBeenCalled();
  });

  it("keeps request media isolated and preserves captionless incoming media type", async () => {
    const first = contextWithReply("one");
    Object.assign(first.message!.reply_to_message!, { photo: [{ file_id: "first" }] });
    const second = contextWithReply("");
    Object.assign(second.message!, { text: undefined, photo: [{ file_id: "current" }] });
    Object.assign(second.message!.reply_to_message!, { audio: { file_id: "second" } });
    await enrichTelegramReplyContext(first, "/tmp/workspace");
    await enrichTelegramReplyContext(second, "/tmp/workspace");
    expect(preparedReply(first)?.fileParts).toHaveLength(1);
    expect(preparedReply(second)?.fileParts).toHaveLength(0);
    expect(second.message?.text).toBeUndefined();
    expect(second.message?.caption).toContain("Replying to");
  });

  it("keeps video frames when transcription fails without exposing the error", async () => {
    const ctx = contextWithReply("compare");
    Object.assign(ctx.message!.reply_to_message!, { video: { file_id: "clip" } });
    transcribeAudioMock.mockRejectedValue(new Error("private provider details"));
    await enrichTelegramReplyContext(ctx, "/tmp/workspace");
    expect(preparedReply(ctx)?.fileParts).toHaveLength(2);
    expect(preparedReply(ctx)?.text).toContain("unavailable");
    expect(preparedReply(ctx)?.text).not.toContain("private provider details");
  });

  it("labels uncertain audio rather than treating it as reliable speech", async () => {
    const ctx = contextWithReply("compare");
    Object.assign(ctx.message!.reply_to_message!, { voice: { file_id: "speech" } });
    transcribeAudioMock.mockResolvedValue({ text: "unclear words", uncertain: true });
    await enrichTelegramReplyContext(ctx, "/tmp/workspace");
    expect(preparedReply(ctx)?.text).toContain("uncertain");
  });

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

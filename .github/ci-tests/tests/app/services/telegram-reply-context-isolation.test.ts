import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  downloadTelegramFileMock: vi.fn(),
  promptAttachmentSetMock: vi.fn(),
  promptAttachmentSetManyMock: vi.fn(),
  extractVideoFramesMock: vi.fn(),
  extractVideoAudioMock: vi.fn(),
  isSttConfiguredMock: vi.fn(),
  transcribeAudioMock: vi.fn(),
}));

vi.mock("../../../src/app/services/file-download-service.js", () => ({
  downloadTelegramFile: downloadTelegramFileMock,
}));

vi.mock("../../../src/app/managers/prompt-attachment-manager.js", () => ({
  promptAttachment: {
    set: promptAttachmentSetMock,
    setMany: promptAttachmentSetManyMock,
    __resetForTests: vi.fn(),
  },
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

function contextWithCrossTopicReply(replyContent: Record<string, unknown>): Context {
  return {
    api: {},
    chat: { id: 100, type: "private" },
    message: {
      message_thread_id: 101,
      text: "continue this",
      reply_to_message: {
        message_id: 10,
        message_thread_id: 202,
        from: { first_name: "Other Topic" },
        ...replyContent,
      },
    },
  } as unknown as Context;
}

describe("Telegram reply context isolation", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "reply-context-isolation-"));
    downloadTelegramFileMock.mockReset().mockResolvedValue({ buffer: Buffer.from("asset"), mimeType: "image/jpeg" });
    promptAttachmentSetMock.mockReset();
    promptAttachmentSetManyMock.mockReset();
    extractVideoFramesMock.mockReset().mockResolvedValue([
      { filename: "frame-01.jpg", buffer: Buffer.from("frame") },
    ]);
    extractVideoAudioMock.mockReset().mockResolvedValue({ buffer: Buffer.from("audio"), filename: "audio.ogg" });
    isSttConfiguredMock.mockReset().mockResolvedValue(true);
    transcribeAudioMock.mockReset().mockResolvedValue({ text: "transcribed speech", uncertain: false });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function expectNoWorkspaceWrite(): void {
    expect(existsSync(path.join(workspace, ".telegram", "replies"))).toBe(false);
  }

  it("does not enrich reply text from another Topic", async () => {
    const ctx = contextWithCrossTopicReply({ text: "private text from Topic 202" });

    await enrichTelegramReplyContext(ctx, workspace);

    expect(ctx.message?.text).toBe("continue this");
    expect(promptAttachmentSetMock).not.toHaveBeenCalled();
    expect(promptAttachmentSetManyMock).not.toHaveBeenCalled();
    expectNoWorkspaceWrite();
  });

  it("does not attach or persist a replied photo from another Topic", async () => {
    const ctx = contextWithCrossTopicReply({
      photo: [{ file_id: "photo-b" }],
      caption: "photo from Topic 202",
    });

    await enrichTelegramReplyContext(ctx, workspace);

    expect(downloadTelegramFileMock).not.toHaveBeenCalled();
    expect(ctx.message?.text).toBe("continue this");
    expect(promptAttachmentSetMock).not.toHaveBeenCalled();
    expectNoWorkspaceWrite();
  });

  it("does not attach or persist a replied document from another Topic", async () => {
    const ctx = contextWithCrossTopicReply({
      document: { file_id: "document-b", file_name: "secret.txt" },
    });

    await enrichTelegramReplyContext(ctx, workspace);

    expect(downloadTelegramFileMock).not.toHaveBeenCalled();
    expect(ctx.message?.text).toBe("continue this");
    expect(promptAttachmentSetMock).not.toHaveBeenCalled();
    expectNoWorkspaceWrite();
  });

  it("does not create video-frame attachments from another Topic", async () => {
    const ctx = contextWithCrossTopicReply({
      video: { file_id: "video-b", file_name: "secret.mp4" },
    });

    await enrichTelegramReplyContext(ctx, workspace);

    expect(downloadTelegramFileMock).not.toHaveBeenCalled();
    expect(extractVideoFramesMock).not.toHaveBeenCalled();
    expect(ctx.message?.text).toBe("continue this");
    expect(promptAttachmentSetManyMock).not.toHaveBeenCalled();
    expectNoWorkspaceWrite();
  });
});

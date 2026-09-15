import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

vi.mock("../../../src/bot/handlers/message-merger.js", () => ({
  flushPendingPrompt: vi.fn(),
  __resetMessageMergerForTests: vi.fn(),
}));

import { buildVideoAnalysisPrompt, handleVideoMessage, MAX_VIDEO_BYTES, type VideoHandlerDeps } from "../../../src/bot/handlers/video-handler.js";
import { t } from "../../../src/i18n/index.js";

function createVideoContext(caption = "", fileSize = 4_000_000): { ctx: Context; replyMock: ReturnType<typeof vi.fn> } {
  const replyMock = vi.fn().mockResolvedValue({ message_id: 100 });
  const ctx = {
    chat: { id: 777 },
    message: { caption, video: { file_id: "video-1", file_unique_id: "v1", file_size: fileSize } },
    reply: replyMock,
    api: {},
  } as unknown as Context;
  return { ctx, replyMock };
}

function createDeps(overrides: Partial<VideoHandlerDeps> = {}) {
  const processPromptMock = vi.fn().mockResolvedValue(true);
  const downloadMock = vi.fn().mockResolvedValue({ buffer: Buffer.from("video-bytes"), filePath: "documents/file.mp4" });
  const extractMock = vi.fn().mockResolvedValue([
    { filename: "frame-01.jpg", buffer: Buffer.from("frame1") },
    { filename: "frame-02.jpg", buffer: Buffer.from("frame2") },
  ]);
  const deps: VideoHandlerDeps = {
    bot: {} as VideoHandlerDeps["bot"],
    ensureEventSubscription: vi.fn().mockResolvedValue(undefined),
    downloadFile: downloadMock,
    getModelCapabilities: vi.fn().mockResolvedValue({ input: { image: true } }),
    getStoredModel: vi.fn(() => ({ providerID: "test-provider", modelID: "test-model" })),
    processPrompt: processPromptMock,
    extractFrames: extractMock,
    ...overrides,
  };
  return { deps, processPromptMock, downloadMock, extractMock };
}

describe("bot/handlers/video-handler", () => {
  it("builds a default frame-by-frame analysis instruction when there is no caption", () => {
    const prompt = buildVideoAnalysisPrompt("", 8);
    expect(prompt).toContain("frame by frame");
    expect(prompt).toContain("8 keyframes");
    expect(buildVideoAnalysisPrompt("what happens here?", 4)).toBe("what happens here?");
  });

  it("sends extracted frames as image file parts to the coding model", async () => {
    const { ctx } = createVideoContext();
    const { deps, processPromptMock, downloadMock, extractMock } = createDeps();

    await handleVideoMessage(ctx, deps);

    expect(downloadMock).toHaveBeenCalledWith(ctx.api, "video-1");
    expect(extractMock).toHaveBeenCalledWith(expect.any(Buffer), "documents/file.mp4");
    const [text, , fileParts] = processPromptMock.mock.calls[0] ?? [];
    expect(text).toContain("frame by frame");
    expect(fileParts).toHaveLength(2);
    expect(fileParts[0]).toMatchObject({ type: "file", mime: "image/jpeg", filename: "frame-01.jpg" });
    expect(String(fileParts[0].url)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("uses the caption as the prompt text", async () => {
    const { ctx } = createVideoContext("summarize this clip");
    const { deps, processPromptMock } = createDeps();
    await handleVideoMessage(ctx, deps);
    expect(processPromptMock.mock.calls[0]?.[0]).toBe("summarize this clip");
  });

  it("rejects videos above the Telegram bot download limit", async () => {
    const { ctx, replyMock } = createVideoContext("", MAX_VIDEO_BYTES + 1);
    const { deps, downloadMock } = createDeps();
    await handleVideoMessage(ctx, deps);
    expect(downloadMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(expect.stringContaining("too large"));
  });

  it("refuses when the selected model has no image input", async () => {
    const { ctx, replyMock } = createVideoContext();
    const { deps, extractMock } = createDeps({
      getModelCapabilities: vi.fn().mockResolvedValue({ input: { image: false } }) as VideoHandlerDeps["getModelCapabilities"],
    });
    await handleVideoMessage(ctx, deps);
    expect(extractMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(t("bot.photo_model_no_image"));
  });

  it("reports a generic error when frame extraction fails", async () => {
    const { ctx, replyMock } = createVideoContext();
    const { deps } = createDeps({ extractFrames: vi.fn().mockRejectedValue(new Error("ffmpeg crashed")) as VideoHandlerDeps["extractFrames"] });
    await handleVideoMessage(ctx, deps);
    expect(replyMock).toHaveBeenCalledWith(t("bot.video_error"));
    const errorTexts = replyMock.mock.calls.map(([text]) => String(text)).join("|");
    expect(errorTexts).not.toContain("ffmpeg crashed");
  });
});

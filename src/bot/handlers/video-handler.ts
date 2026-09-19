import type { Context } from "grammy";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import { downloadTelegramFile, toDataUri, type DownloadedFile } from "../../app/services/file-download-service.js";
import { getModelCapabilities, supportsInput } from "../../app/services/model-capabilities-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { isSttConfigured, transcribeAudio } from "../../app/services/stt-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { extractVideoAudio, extractVideoFrames, type ExtractedVideoFrame } from "../../app/services/video-preparation-service.js";
import { flushPendingPrompt } from "./message-merger.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";

/** Telegram Bot API getFile downloads are capped at 20 MB. */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

export interface VideoHandlerDeps extends ProcessPromptDeps {
  downloadFile?: (api: Context["api"], fileId: string) => Promise<DownloadedFile>;
  getModelCapabilities?: (providerId: string, modelId: string) => Promise<Awaited<ReturnType<typeof getModelCapabilities>> | null>;
  getStoredModel?: () => { providerID: string; modelID: string };
  processPrompt?: (ctx: Context, text: string, deps: ProcessPromptDeps, fileParts?: FilePartInput[]) => Promise<boolean>;
  extractFrames?: (videoBuffer: Buffer, sourceFilename: string) => Promise<ExtractedVideoFrame[]>;
}

export type { ExtractedVideoFrame };
export { extractVideoFrames };
/** Backward-compatible name used by existing handler tests/callers. */
export const extractAudio = extractVideoAudio;

export function buildVideoAnalysisPrompt(caption: string, frameCount: number, transcription?: string): string {
  const parts: string[] = [];
  if (caption) {
    parts.push(caption);
  } else {
    parts.push(`Analyze this video frame by frame. ${frameCount} keyframes were sampled in chronological order from the video I sent. Describe what happens, the notable changes between frames, and transcribe any text visible in the frames.`);
  }
  if (transcription) parts.push(`\n\nAudio transcription from the video:\n${transcription}`);
  return parts.join("\n");
}

export async function handleVideoMessage(ctx: Context, deps: VideoHandlerDeps): Promise<void> {
  const video = ctx.message?.video ?? ctx.message?.video_note;
  if (!video) return;
  const caption = ctx.message?.caption?.trim() ?? "";
  flushPendingPrompt(ctx.chat!.id);

  const downloadFile = deps.downloadFile ?? downloadTelegramFile;
  const getCapabilities = deps.getModelCapabilities ?? getModelCapabilities;
  const getStored = deps.getStoredModel ?? getStoredModel;
  const processPrompt = deps.processPrompt ?? processUserPrompt;
  const extractFrames = deps.extractFrames ?? extractVideoFrames;

  try {
    const storedModel = getStored();
    const capabilities = await getCapabilities(storedModel.providerID, storedModel.modelID);
    if (!supportsInput(capabilities, "image")) {
      logger.warn(`[Video] Model ${storedModel.providerID}/${storedModel.modelID} doesn't support image input`);
      await ctx.reply(t("bot.photo_model_no_image"));
      return;
    }
    if ((video.file_size ?? 0) > MAX_VIDEO_BYTES) {
      await ctx.reply(t("bot.video_too_large", { maxSizeMb: String(Math.floor(MAX_VIDEO_BYTES / (1024 * 1024))) }));
      return;
    }
    await ctx.reply(t("bot.video_downloading"));
    const downloaded = await downloadFile(ctx.api, video.file_id);
    const frames = await extractFrames(downloaded.buffer, downloaded.filePath || "video.mp4");
    const fileParts: FilePartInput[] = frames.map((frame) => ({
      type: "file",
      mime: "image/jpeg",
      filename: frame.filename,
      url: toDataUri(frame.buffer, "image/jpeg"),
    }));

    let transcription: string | undefined;
    if (await isSttConfigured()) {
      try {
        const audio = await extractAudio(downloaded.buffer, downloaded.filePath || "video.mp4");
        if (audio) {
          logger.debug(`[Video] Extracted audio: ${audio.buffer.length} bytes`);
          const result = await transcribeAudio(audio.buffer, audio.filename);
          if (result.text.trim()) {
            transcription = result.text.trim();
            logger.info(`[Video] Audio transcription: ${transcription.length} chars`);
          }
        }
      } catch (err) {
        logger.warn("[Video] Audio transcription failed, proceeding with frames only:", err);
      }
    }

    logger.info(`[Video] Sending ${fileParts.length} frames (${downloaded.buffer.length} byte source) to selected coding model`);
    await processPrompt(ctx, buildVideoAnalysisPrompt(caption, fileParts.length, transcription), deps, fileParts);
  } catch (err) {
    logger.error("[Video] Error handling video message:", err);
    await ctx.reply(t("bot.video_error"));
  }
}
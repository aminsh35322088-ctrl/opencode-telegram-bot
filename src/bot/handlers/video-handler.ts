import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Context } from "grammy";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import { downloadTelegramFile, toDataUri, type DownloadedFile } from "../../app/services/file-download-service.js";
import { getModelCapabilities, supportsInput } from "../../app/services/model-capabilities-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { flushPendingPrompt } from "./message-merger.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";

const execFileAsync = promisify(execFile);

/** Telegram Bot API getFile downloads are capped at 20 MB. */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_FRAMES = 12;
const FRAME_WIDTH = 512;
const FFMPEG_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 15_000;

export interface VideoHandlerDeps extends ProcessPromptDeps {
  downloadFile?: (api: Context["api"], fileId: string) => Promise<DownloadedFile>;
  getModelCapabilities?: (providerId: string, modelId: string) => Promise<Awaited<ReturnType<typeof getModelCapabilities>> | null>;
  getStoredModel?: () => { providerID: string; modelID: string };
  processPrompt?: (ctx: Context, text: string, deps: ProcessPromptDeps, fileParts?: FilePartInput[]) => Promise<boolean>;
  extractFrames?: (videoBuffer: Buffer, sourceFilename: string) => Promise<Array<{ filename: string; buffer: Buffer }>>;
}

export interface ExtractedVideoFrame {
  filename: string;
  buffer: Buffer;
}

/** Samples up to MAX_FRAMES evenly spaced keyframes (max 1 fps) downscaled to FRAME_WIDTH. */
export async function extractVideoFrames(videoBuffer: Buffer, sourceFilename: string): Promise<ExtractedVideoFrame[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "otb-video-"));
  try {
    const extension = path.extname(sourceFilename) || ".mp4";
    const inputPath = path.join(dir, `input${extension}`);
    await fs.writeFile(inputPath, videoBuffer);

    let durationSec = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath], { timeout: FFPROBE_TIMEOUT_MS });
      durationSec = Number.parseFloat(stdout.trim()) || 0;
    } catch {
      durationSec = 0;
    }
    const fps = durationSec > 0 ? Math.min(1, MAX_FRAMES / durationSec) : 1;

    await execFileAsync("ffmpeg", ["-v", "error", "-i", inputPath, "-vf", `fps=${fps.toFixed(4)},scale=${FRAME_WIDTH}:-2`, "-frames:v", String(MAX_FRAMES), "-q:v", "4", path.join(dir, "frame-%02d.jpg")], { timeout: FFMPEG_TIMEOUT_MS });

    const names = (await fs.readdir(dir)).filter((name) => /^frame-\d+\.jpg$/u.test(name)).sort();
    const frames: ExtractedVideoFrame[] = [];
    for (const name of names) {
      frames.push({ filename: name, buffer: await fs.readFile(path.join(dir, name)) });
    }
    if (!frames.length) throw new Error("No frames could be extracted from the video");
    return frames;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function buildVideoAnalysisPrompt(caption: string, frameCount: number): string {
  if (caption) return caption;
  return `Analyze this video frame by frame. ${frameCount} keyframes were sampled in chronological order from the video I sent. Describe what happens, the notable changes between frames, and transcribe any text visible in the frames.`;
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
    logger.info(`[Video] Sending ${fileParts.length} frames (${downloaded.buffer.length} byte source) to selected coding model`);
    await processPrompt(ctx, buildVideoAnalysisPrompt(caption, fileParts.length), deps, fileParts);
  } catch (err) {
    logger.error("[Video] Error handling video message:", err);
    await ctx.reply(t("bot.video_error"));
  }
}

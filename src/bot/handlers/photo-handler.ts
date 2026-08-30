import type { Context } from "grammy";
import type { FilePartInput, Model } from "@opencode-ai/sdk/v2";
import { downloadTelegramFile, toDataUri } from "../../app/services/file-download-service.js";
import { getModelCapabilities, supportsInput } from "../../app/services/model-capabilities-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { flushPendingPrompt } from "./message-merger.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import { editPhotoMessage } from "../commands/media-command.js";

export interface PhotoHandlerDeps extends ProcessPromptDeps {
  downloadFile?: (api: Context["api"], fileId: string) => Promise<{ buffer: Buffer; filePath: string }>;
  getModelCapabilities?: (providerId: string, modelId: string) => Promise<Model["capabilities"] | null>;
  getStoredModel?: () => { providerID: string; modelID: string };
  processPrompt?: (ctx: Context, text: string, deps: ProcessPromptDeps, fileParts?: FilePartInput[]) => Promise<boolean>;
}

export async function handlePhotoMessage(ctx: Context, deps: PhotoHandlerDeps): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;
  flushPendingPrompt(ctx.chat!.id);

  const caption = ctx.message.caption?.trim() ?? "";
  const largestPhoto = photos[photos.length - 1];
  if (!largestPhoto) return;

  // A caption attached directly to a photo is an explicit multimodal request.
  // Never pass it through the coding prompt router or keyword intent detection.
  if (caption) {
    logger.info(`[Bot] Photo+caption detected; routing directly to Gemini image AI: chatId=${ctx.chat?.id}`);
    await editPhotoMessage(ctx, caption);
    return;
  }

  const downloadFile = deps.downloadFile ?? downloadTelegramFile;
  const getCapabilities = deps.getModelCapabilities ?? getModelCapabilities;
  const getStored = deps.getStoredModel ?? getStoredModel;
  const processPrompt = deps.processPrompt ?? processUserPrompt;

  try {
    const storedModel = getStored();
    const capabilities = await getCapabilities(storedModel.providerID, storedModel.modelID);
    if (!supportsInput(capabilities, "image")) {
      logger.warn(`[Bot] Model ${storedModel.providerID}/${storedModel.modelID} doesn't support image input`);
      await ctx.reply(t("bot.photo_model_no_image"));
      return;
    }

    await ctx.reply(t("bot.photo_downloading"));
    const downloadedFile = await downloadFile(ctx.api, largestPhoto.file_id);
    const filePart: FilePartInput = { type: "file", mime: "image/jpeg", filename: "photo.jpg", url: toDataUri(downloadedFile.buffer, "image/jpeg") };
    logger.info(`[Bot] Sending captionless photo (${downloadedFile.buffer.length} bytes) to the selected coding model`);
    await processPrompt(ctx, "", deps, [filePart]);
  } catch (err) {
    logger.error("[Bot] Error handling photo message:", err);
    await ctx.reply(t("bot.photo_download_error"));
  }
}

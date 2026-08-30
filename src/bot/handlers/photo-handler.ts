import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { FilePartInput, Model } from "@opencode-ai/sdk/v2";
import { downloadTelegramFile, toDataUri } from "../../app/services/file-download-service.js";
import { getModelCapabilities, supportsInput } from "../../app/services/model-capabilities-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { flushPendingPrompt } from "./message-merger.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import { editPhotoMessage, generateImage, isMediaAiConfigured } from "../commands/media-command.js";

export interface PhotoHandlerDeps extends ProcessPromptDeps {
  downloadFile?: (api: Context["api"], fileId: string) => Promise<{ buffer: Buffer; filePath: string }>;
  getModelCapabilities?: (providerId: string, modelId: string) => Promise<Model["capabilities"] | null>;
  getStoredModel?: () => { providerID: string; modelID: string };
  processPrompt?: (ctx: Context, text: string, deps: ProcessPromptDeps, fileParts?: FilePartInput[]) => Promise<boolean>;
}

const IMAGE_EDIT_INTENT_PATTERN = /(?:\b(?:edit|change|modify|remove|replace|add|delete|background|backdrop|style|transform|enhance|upscale|crop|resize|retouch|restore|fix)\b|ویرایش|تغییر|حذف|اضافه|جایگزین|پس.?زمینه|بک.?گراند|استایل|تبدیل|بهبود|واضح|بزرگ|کوچک|ترمیم|اصلاح)/iu;
const IMAGE_GENERATE_INTENT_PATTERN = /(?:\b(?:generate|create|draw|make|design|render|produce|imagine|invent|illustrate)\b|\b(?:image|picture|illustration|poster|logo|banner|avatar)\b|بساز|ایجاد|تولید|طراحی|رندر|نقاشی|تصویر|عکس|پوستر|لوگو|بنر|آواتار)/iu;

export function isImageEditIntent(text: string): boolean {
  return IMAGE_EDIT_INTENT_PATTERN.test(text);
}

export function isImageGenerateIntent(text: string): boolean {
  return IMAGE_GENERATE_INTENT_PATTERN.test(text);
}

export async function handlePhotoMessage(ctx: Context, deps: PhotoHandlerDeps): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;
  flushPendingPrompt(ctx.chat!.id);

  const caption = ctx.message.caption?.trim() ?? "";
  const largestPhoto = photos[photos.length - 1];
  if (!largestPhoto) return;

  // Media captions are handled before the coding pipeline. Explicit generation
  // captions create a fresh image; edit captions transform the attached image.
  if (caption && (isImageGenerateIntent(caption) || isImageEditIntent(caption))) {
    if (!(await isMediaAiConfigured())) {
      await ctx.reply("🎨 Image AI is not configured. Open /providers and configure Gemini / Nano Banana.");
      return;
    }

    try {
      await ctx.replyWithChatAction("upload_photo");
      if (isImageEditIntent(caption)) {
        await editPhotoMessage(ctx, caption);
        return;
      }

      const result = await generateImage(caption);
      await ctx.replyWithPhoto(
        new InputFile(result.buffer, `generated.${result.mimeType.split("/")[1] ?? "png"}`),
        { caption: "🎨 Generated with Nano Banana" },
      );
      logger.info(`[Bot] Photo caption routed to Gemini generation: chatId=${ctx.chat?.id}`);
    } catch (err) {
      logger.error("[Bot] Error handling photo caption media request:", err);
      await ctx.reply(`❌ Image AI failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    await processPrompt(ctx, caption, deps, [filePart]);
  } catch (err) {
    logger.error("[Bot] Error handling photo message:", err);
    await ctx.reply(t("bot.photo_download_error"));
  }
}

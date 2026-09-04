import { InputFile, type Context } from "grammy";
import { downloadPhoto, downloadRepliedPhoto } from "../services/media-ai-service.js";
import { generateImageWithFallback, editImageWithFallback, hasActiveImageAiProvider } from "../../app/services/image-ai-provider-service.js";
import { saveTopicImageAsset } from "../../app/services/telegram-topic-image-asset-service.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { beginImageAiOperation, endImageAiOperation } from "../../app/services/image-mode-service.js";
export { downloadPhoto } from "../services/media-ai-service.js";

async function runImageAiOperation<T>(operation: () => Promise<T>): Promise<T> {
  const session = getCurrentSession();
  const sessionId = session?.id;
  const directory = session?.directory;
  if (sessionId && directory) {
    foregroundSessionState.markBusy(sessionId, directory);
    beginImageAiOperation(sessionId);
  } else {
    beginImageAiOperation();
  }

  try {
    return await operation();
  } finally {
    if (sessionId) foregroundSessionState.markIdle(sessionId);
    endImageAiOperation(sessionId);
  }
}

export async function editImage(image: Buffer, mimeType: string, prompt: string) {
  return runImageAiOperation(() => editImageWithFallback(image, mimeType, prompt));
}

export async function isMediaAiConfigured(): Promise<boolean> {
  return hasActiveImageAiProvider("generate") || hasActiveImageAiProvider("edit");
}

function commandArguments(ctx: Context): string {
  return (ctx.message?.text ?? "").replace(/^\/\w+(?:@\w+)?\s*/u, "").trim();
}

function mediaNotConfiguredMessage(): string {
  return "🎨 Image AI is not configured. Open /providers → 🎨 Image AI and configure a provider.";
}

async function sendGeneratedImage(ctx: Context, prompt: string): Promise<void> {
  if (!(await hasActiveImageAiProvider("generate"))) {
    await ctx.reply(mediaNotConfiguredMessage());
    return;
  }
  if (!prompt.trim()) {
    await ctx.reply("Usage: /image <prompt>");
    return;
  }

  await runImageAiOperation(async () => {
    await ctx.replyWithChatAction("upload_photo");
    const result = await generateImageWithFallback(prompt.trim());
    const asset = await saveTopicImageAsset(result.buffer, result.mimeType, "generated", getCurrentSession() ?? undefined);
    const caption = asset
      ? `🎨 Generated with Image AI\n📁 ${asset.relativePath}`
      : "🎨 Generated with Image AI";
    await ctx.replyWithPhoto(
      new InputFile(result.buffer, `generated.${result.mimeType.split("/")[1] ?? "png"}`),
      { caption },
    );
  });
}

export async function imageCommand(ctx: Context): Promise<void> {
  try {
    await sendGeneratedImage(ctx, commandArguments(ctx));
  } catch (error) {
    await ctx.reply(`❌ Image generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function editCommand(ctx: Context): Promise<void> {
  if (!(await hasActiveImageAiProvider("edit"))) {
    await ctx.reply(mediaNotConfiguredMessage());
    return;
  }
  const prompt = commandArguments(ctx);
  if (!prompt) {
    await ctx.reply("Usage: reply to a photo with /edit <instruction>");
    return;
  }
  const sessionAtStart = getCurrentSession();
  try {
    await runImageAiOperation(async () => {
      const source = await downloadRepliedPhoto(ctx);
      await ctx.replyWithChatAction("upload_photo");
      const result = await editImageWithFallback(source.buffer, source.mimeType, prompt);
      const asset = await saveTopicImageAsset(result.buffer, result.mimeType, "edited", sessionAtStart ?? undefined);
      const caption = asset
        ? `✨ Edited with Image AI\n📁 ${asset.relativePath}`
        : "✨ Edited with Image AI";
      await ctx.replyWithPhoto(
        new InputFile(result.buffer, `edited.${result.mimeType.split("/")[1] ?? "png"}`),
        { caption },
      );
    });
  } catch (error) {
    await ctx.reply(`❌ Image editing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Called only by an explicit Image AI mode (keyboard) or explicit /image command.
 * Deliberately does not inspect prompt text for image keywords.
 */
export async function handleImageTextPrompt(ctx: Context, prompt: string): Promise<boolean> {
  try {
    await sendGeneratedImage(ctx, prompt);
  } catch (error) {
    await ctx.reply(`❌ Image generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

export async function handlePhotoCaptionMessage(ctx: Context, prompt: string): Promise<void> {
  if (!(await hasActiveImageAiProvider("edit"))) {
    await ctx.reply(mediaNotConfiguredMessage());
    return;
  }
  if (!prompt.trim()) return;
  const sessionAtStart = getCurrentSession();
  try {
    await runImageAiOperation(async () => {
      const source = await downloadPhoto(ctx);
      await ctx.replyWithChatAction("upload_photo");
      const result = await editImageWithFallback(source.buffer, source.mimeType, prompt.trim());
      const asset = await saveTopicImageAsset(result.buffer, result.mimeType, "edited", sessionAtStart ?? undefined);
      const caption = asset
        ? `✨ Edited with Image AI\n📁 ${asset.relativePath}`
        : "✨ Edited with Image AI";
      await ctx.replyWithPhoto(
        new InputFile(result.buffer, `edited.${result.mimeType.split("/")[1] ?? "png"}`),
        { caption },
      );
    });
  } catch (error) {
    await ctx.reply(`❌ Image editing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function editPhotoMessage(ctx: Context, prompt: string): Promise<void> {
  await handlePhotoCaptionMessage(ctx, prompt);
}

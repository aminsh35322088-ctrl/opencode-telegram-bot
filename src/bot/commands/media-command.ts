import { InputFile, type Context } from "grammy";
import {
  downloadPhoto,
  downloadRepliedPhoto,
  editImage,
  generateImage,
  isMediaAiConfigured,
} from "../services/media-ai-service.js";

function commandArguments(ctx: Context): string {
  return (ctx.message?.text ?? "").replace(/^\/\w+(?:@\w+)?\s*/u, "").trim();
}

async function sendGeneratedImage(ctx: Context, prompt: string): Promise<void> {
  if (!isMediaAiConfigured()) {
    await ctx.reply("🎨 Image AI is not configured. Set GEMINI_API_KEY first.");
    return;
  }
  if (!prompt) {
    await ctx.reply("Usage: /image <prompt>\nExample: /image a cinematic cyberpunk city at night");
    return;
  }

  await ctx.replyWithChatAction("upload_photo");
  const result = await generateImage(prompt);
  await ctx.replyWithPhoto(new InputFile(result.buffer, `generated.${result.mimeType.split("/")[1] ?? "png"}`), {
    caption: "🎨 Generated with Nano Banana",
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
  if (!isMediaAiConfigured()) {
    await ctx.reply("🎨 Image AI is not configured. Set GEMINI_API_KEY first.");
    return;
  }

  const prompt = commandArguments(ctx);
  if (!prompt) {
    await ctx.reply("Usage: reply to a photo with /edit <instruction>\nExample: /edit remove the background and replace it with a blue studio backdrop");
    return;
  }

  try {
    const source = await downloadRepliedPhoto(ctx);
    await ctx.replyWithChatAction("upload_photo");
    const result = await editImage(source.buffer, source.mimeType, prompt);
    await ctx.replyWithPhoto(new InputFile(result.buffer, `edited.${result.mimeType.split("/")[1] ?? "png"}`), {
      caption: "✨ Edited with Nano Banana",
    });
  } catch (error) {
    await ctx.reply(`❌ Image editing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function editPhotoMessage(ctx: Context, prompt: string): Promise<void> {
  if (!isMediaAiConfigured()) {
    await ctx.reply("🎨 Image AI is not configured. Set GEMINI_API_KEY first.");
    return;
  }
  if (!prompt) {
    await ctx.reply("Usage: send a photo with /edit <instruction> as its caption.");
    return;
  }

  try {
    const source = await downloadPhoto(ctx);
    await ctx.replyWithChatAction("upload_photo");
    const result = await editImage(source.buffer, source.mimeType, prompt);
    await ctx.replyWithPhoto(new InputFile(result.buffer, `edited.${result.mimeType.split("/")[1] ?? "png"}`), {
      caption: "✨ Edited with Nano Banana",
    });
  } catch (error) {
    await ctx.reply(`❌ Image editing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

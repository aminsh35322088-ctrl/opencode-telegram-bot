import { InputFile, type Bot, type Context } from "grammy";
import { MAIN_BUTTONS } from "../keyboards/main-reply-keyboard.js";
import { downloadPhoto } from "../services/media-ai-service.js";
import {
  activateImageConversation,
  clearImageConversation,
  handleImageConversationText,
  isImageConversationActive,
  setCurrentImage,
} from "../../app/services/image-conversation-service.js";
import { logger } from "../../utils/logger.js";

interface ImageAiConversationDeps {
  setTelegramContext: (bot: Bot<Context>, chatId: number) => void;
}

function isExitControl(text: string): boolean {
  return [
    MAIN_BUTTONS.history,
    MAIN_BUTTONS.newChat,
    MAIN_BUTTONS.settings,
    MAIN_BUTTONS.compact(false),
    MAIN_BUTTONS.compact(true),
    MAIN_BUTTONS.pause,
    MAIN_BUTTONS.resume,
    MAIN_BUTTONS.abort,
  ].includes(text as never);
}

async function sendResult(ctx: Context, result: Awaited<ReturnType<typeof handleImageConversationText>>): Promise<void> {
  await ctx.reply(result.reply);
  if (!result.image) return;
  await ctx.replyWithPhoto(new InputFile(result.image.buffer, `image-ai.${result.image.mimeType.split("/")[1] ?? "png"}`), {
    caption: result.operation === "edit" ? "✨ Updated with Image AI" : "🎨 Created with Image AI",
  });
}

export function registerImageAiConversationMiddleware(bot: Bot<Context>, deps: ImageAiConversationDeps): void {
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    deps.setTelegramContext(bot, chatId);
    const text = ctx.message?.text?.trim();

    if (text === MAIN_BUTTONS.imageAi) {
      if (isImageConversationActive(chatId)) {
        clearImageConversation(chatId);
        await ctx.reply("❌ <b>Image AI</b> closed. Back to normal chat.", { parse_mode: "HTML" });
      } else {
        activateImageConversation(chatId);
        await ctx.reply("🎨 <b>Image AI is active.</b>\nTalk to me naturally and we’ll create and refine images together.\n\nTap 🎨 Image AI again to exit.", { parse_mode: "HTML" });
      }
      return;
    }

    if (!isImageConversationActive(chatId)) return next();

    if (text?.startsWith("/")) {
      clearImageConversation(chatId);
      return next();
    }

    if (text && isExitControl(text)) {
      clearImageConversation(chatId);
      return next();
    }

    if (text) {
      try {
        await ctx.replyWithChatAction("typing");
        const result = await handleImageConversationText(chatId, text);
        await sendResult(ctx, result);
      } catch (error) {
        logger.error(`[ImageConversation] text failed chatId=${chatId}`, error);
        await ctx.reply(`❌ Image AI failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (ctx.message?.photo) {
      try {
        const image = await downloadPhoto(ctx);
        setCurrentImage(chatId, image);
        const caption = ctx.message.caption?.trim();
        if (!caption) {
          await ctx.reply("🖼️ Got it. This image is now the current image for our conversation. Tell me what you want to change.");
          return;
        }
        await ctx.replyWithChatAction("upload_photo");
        const result = await handleImageConversationText(chatId, caption);
        await sendResult(ctx, result);
      } catch (error) {
        logger.error(`[ImageConversation] photo failed chatId=${chatId}`, error);
        await ctx.reply(`❌ Image AI failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    return next();
  });
}

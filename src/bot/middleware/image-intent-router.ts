import type { Bot, Context } from "grammy";
import { handleImageTextPrompt, isImageGenerationIntent } from "../commands/media-command.js";
import { isProviderWizardActive } from "../commands/providers-command.js";
import { isIntegrationWizardActive } from "../commands/integrations-command.js";
import { questionManager } from "../../app/managers/question-manager.js";
import { MAIN_BUTTONS } from "../keyboards/main-reply-keyboard.js";
import { logger } from "../../utils/logger.js";

const CONTROL_TEXT = new Set([
  "❌ Cancel",
  MAIN_BUTTONS.pause,
  MAIN_BUTTONS.resume,
  MAIN_BUTTONS.abort,
  MAIN_BUTTONS.history,
  MAIN_BUTTONS.newChat,
  MAIN_BUTTONS.settings,
  MAIN_BUTTONS.editImage,
]);

export function registerImageIntentRouter(bot: Bot<Context>): void {
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text?.trim();
    if (!chatId || !text || text.startsWith("/")) {
      await next();
      return;
    }

    if (CONTROL_TEXT.has(text) || /^📦 Compact: (?:ON|OFF)$/u.test(text)) {
      await next();
      return;
    }

    // Never steal credentials, integration inputs, or interactive answers.
    if (isProviderWizardActive(chatId) || isIntegrationWizardActive(chatId) || questionManager.isActive()) {
      await next();
      return;
    }

    if (!isImageGenerationIntent(text)) {
      await next();
      return;
    }

    logger.info(`[ImageRouter] Detected image-generation intent before coding: chatId=${chatId}`);
    const handled = await handleImageTextPrompt(ctx, text);
    if (!handled) {
      await next();
    }
  });
}

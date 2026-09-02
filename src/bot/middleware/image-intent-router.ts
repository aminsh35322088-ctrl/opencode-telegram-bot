import type { Bot, Context } from "grammy";
import { handleImageTextPrompt } from "../commands/media-command.js";
import { isProviderWizardActive } from "../commands/providers-command.js";
import { isIntegrationWizardActive } from "../commands/integrations-command.js";
import { questionManager } from "../../app/managers/question-manager.js";
import { detectMultimodalIntent } from "../../app/services/multimodal-orchestrator-service.js";
import { MAIN_BUTTONS } from "../keyboards/main-reply-keyboard.js";
import { logger } from "../../utils/logger.js";

const CONTROL_TEXT = new Set(["❌ Cancel", MAIN_BUTTONS.pause, MAIN_BUTTONS.resume, MAIN_BUTTONS.abort, MAIN_BUTTONS.history, MAIN_BUTTONS.newChat, MAIN_BUTTONS.settings, MAIN_BUTTONS.editImage]);

export function imageIntentRouter(bot: Bot<Context>): void {
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text?.trim();
    if (!chatId || !text || text.startsWith("/")) return next();
    if (CONTROL_TEXT.has(text) || /^📦 Compact: (?:ON|OFF)$/u.test(text)) return next();
    if (isProviderWizardActive() || isIntegrationWizardActive() || questionManager.isActive()) return next();
    const decision = detectMultimodalIntent(text);
    logger.debug(`[Orchestrator] route=${decision.route} action=${decision.action} confidence=${decision.confidence} chatId=${chatId} reason=${decision.reason}`);
    if (decision.route === "image" && decision.action === "generate") {
      await handleImageTextPrompt(ctx, text);
      return;
    }
    if (decision.route === "video") {
      await ctx.reply("🎬 Video AI detected, but no verified Video AI model is configured yet. Configure one under /providers when available.");
      return;
    }
    return next();
  });
}

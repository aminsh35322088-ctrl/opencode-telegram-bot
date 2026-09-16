import type { Context } from "grammy";
import { config } from "../../config.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { loadSkillsCatalog } from "../../app/services/skills-catalog-service.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { buildSkillsListKeyboard, formatSkillsSelectText } from "../menus/skills-catalog-menu.js";

export async function skillsCommand(ctx: Context): Promise<void> {
  try {
    const projectDirectory = getCurrentSessionDirectory();
    const skills = await loadSkillsCatalog(projectDirectory);
    const pageSize = config.bot.commandsListLimit;
    const keyboard = buildSkillsListKeyboard(skills, 0, pageSize);
    const callbackMessage = ctx.callbackQuery?.message;
    const callbackMessageId = callbackMessage && "message_id" in callbackMessage ? callbackMessage.message_id : null;
    const text = skills.length > 0 ? formatSkillsSelectText(0) : t("skills.empty");
    let messageId: number;

    if (callbackMessageId !== null && ctx.chat?.id) {
      await ctx.api.editMessageText(ctx.chat.id, callbackMessageId, text, { reply_markup: keyboard });
      await ctx.answerCallbackQuery().catch(() => {});
      messageId = callbackMessageId;
    } else {
      const message = await ctx.reply(text, { reply_markup: keyboard });
      messageId = message.message_id;
    }

    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "skills",
        stage: "list",
        messageId,
        projectDirectory,
        skills,
        page: 0,
      },
    });
  } catch (error) {
    logger.error("[Skills] Error fetching skills list:", error);
    const callbackMessage = ctx.callbackQuery?.message;
    const messageId = callbackMessage && "message_id" in callbackMessage ? callbackMessage.message_id : null;
    if (messageId !== null && ctx.chat?.id) {
      await ctx.api.editMessageText(ctx.chat.id, messageId, t("skills.fetch_error"), {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Home", callback_data: "main:home" }]] },
      }).catch(() => {});
      return;
    }
    await ctx.reply(t("skills.fetch_error"));
  }
}
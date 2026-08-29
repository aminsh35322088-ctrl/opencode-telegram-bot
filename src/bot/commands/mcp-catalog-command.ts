import type { CommandContext, Context } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { loadMcpCatalog } from "../../app/services/mcp-catalog-service.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { buildMcpsListKeyboard } from "../menus/mcp-catalog-menu.js";

export async function mcpsCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    const projectDirectory = getCurrentSessionDirectory();
    const servers = await loadMcpCatalog(projectDirectory);
    if (servers.length === 0) {
      await ctx.reply(t("mcps.empty"));
      return;
    }

    const keyboard = buildMcpsListKeyboard(servers);
    const callbackMessage = ctx.callbackQuery?.message;
    const callbackMessageId = callbackMessage && "message_id" in callbackMessage ? callbackMessage.message_id : null;
    let messageId: number;

    if (callbackMessageId !== null && ctx.chat?.id) {
      await ctx.api.editMessageText(ctx.chat.id, callbackMessageId, t("mcps.select"), {
        reply_markup: keyboard,
      });
      await ctx.answerCallbackQuery().catch(() => {});
      messageId = callbackMessageId;
    } else {
      const message = await ctx.reply(t("mcps.select"), {
        reply_markup: keyboard,
      });
      messageId = message.message_id;
    }

    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "mcps",
        stage: "list",
        messageId,
        projectDirectory,
        servers,
      },
    });
  } catch (error) {
    logger.error("[Mcps] Error fetching MCP servers list:", error);
    await ctx.reply(t("mcps.fetch_error"));
  }
}

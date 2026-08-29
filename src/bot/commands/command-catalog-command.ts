import type { CommandContext, Context } from "grammy";
import { config } from "../../config.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { loadCommandCatalog } from "../../app/services/command-catalog-service.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { buildCommandsListKeyboard, formatCommandsSelectText } from "../menus/command-catalog-menu.js";
import { registerCommandsMenu, type CommandsMetadata } from "../callbacks/command-catalog-callback-handler.js";

export async function commandsCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    const projectDirectory = getCurrentSessionDirectory();
    const commands = await loadCommandCatalog(projectDirectory);
    if (commands.length === 0) {
      await ctx.reply(t("commands.empty"));
      return;
    }

    const pageSize = config.bot.commandsListLimit;
    const keyboard = buildCommandsListKeyboard(commands, 0, pageSize);
    const message = await ctx.reply(formatCommandsSelectText(0), {
      reply_markup: keyboard,
    });

    const metadata: CommandsMetadata = {
      flow: "commands",
      stage: "list",
      messageId: message.message_id,
      projectDirectory,
      commands,
      page: 0,
    };

    registerCommandsMenu(metadata);
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: { ...metadata },
    });
  } catch (error) {
    logger.error("[Commands] Error fetching commands list:", error);
    await ctx.reply(t("commands.fetch_error"));
  }
}

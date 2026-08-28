import { CommandContext, Context } from "grammy";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { buildSessionSelectionMenuView, loadSessionPage } from "../menus/session-selection-menu.js";

export async function sessionsCommand(ctx: CommandContext<Context>) {
  try {
    if (isForegroundBusy()) {
      await replyBusyBlocked(ctx);
      return;
    }

    const pageSize = config.bot.sessionsListLimit;
    const directory = getCurrentSessionDirectory();

    logger.debug(`[Sessions] Fetching sessions for directory: ${directory}`);

    const firstPage = await loadSessionPage(directory, 0, pageSize);

    logger.debug(`[Sessions] Found ${firstPage.sessions.length} sessions on page 1`);
    firstPage.sessions.forEach((session) => {
      logger.debug(`[Sessions] Session: ${session.title} | ${session.directory}`);
    });

    if (firstPage.sessions.length === 0) {
      await ctx.reply(t("sessions.empty"));
      return;
    }

    const { text, keyboard } = buildSessionSelectionMenuView(firstPage, pageSize);

    await replyWithInlineMenu(ctx, {
      menuKind: "session",
      text,
      keyboard,
    });
  } catch (error) {
    logger.error("[Sessions] Error fetching sessions:", error);
    await ctx.reply(t("sessions.fetch_error"));
  }
}

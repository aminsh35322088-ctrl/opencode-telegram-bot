import { CommandContext, Context } from "grammy";
import { replyWithInlineMenu } from "../menus/inline-menu.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { buildSessionSelectionMenuView, type SessionPage } from "../menus/session-selection-menu.js";
import { listTelegramTopicBindings } from "../../app/services/telegram-topic-store.js";

export async function sessionsCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    if (isForegroundBusy()) { await replyBusyBlocked(ctx); return; }
    const pageSize = config.bot.sessionsListLimit;
    const bindings = (await listTelegramTopicBindings())
      .filter((binding) => binding.chatId === ctx.chat.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const page: SessionPage = {
      sessions: bindings.slice(0, pageSize).map((binding) => ({
        id: binding.sessionId,
        title: binding.title ?? "Telegram Topic",
        directory: binding.directory,
        time: { created: Date.parse(binding.createdAt) || Date.now() },
      })),
      hasNext: bindings.length > pageSize,
      page: 0,
    };
    if (page.sessions.length === 0) { await ctx.reply(t("sessions.empty")); return; }
    const view = buildSessionSelectionMenuView(page, pageSize);
    await replyWithInlineMenu(ctx, { menuKind: "session", text: `🗂 Topic History\n\n${view.text.replace(/^🕘\s*/u, "")}`, keyboard: view.keyboard });
  } catch (error) {
    logger.error("[TopicHistory] Failed to load topic history:", error);
    await ctx.reply(t("sessions.fetch_error"));
  }
}

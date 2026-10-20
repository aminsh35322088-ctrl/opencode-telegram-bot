import type { CommandContext, Context } from "grammy";
import { getProjectRoot, isWithinProjectRoot } from "../../app/services/file-browser-service.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { t } from "../../i18n/index.js";
import { isContainerRuntime } from "../../runtime/container.js";
import { buildRemoteLsBrowseView, clearLsPathIndex, renderLsBrowseView } from "../menus/file-browser-menu.js";
import { listRemoteWorkerFiles, normalizeRemoteRelativePath, resolveReadyTopicWorker } from "../../app/services/remote-worker-file-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { rememberLsDirectory, resolveInitialLsDirectory } from "../callbacks/file-browser-callback-handler.js";

export async function lsCommand(ctx: CommandContext<Context>): Promise<void> {
  if (isForegroundBusy()) {
    await replyBusyBlocked(ctx);
    return;
  }

  clearLsPathIndex();

  const sourceMessage = ctx.message as (typeof ctx.message & { message_thread_id?: number });
  const threadId = sourceMessage?.message_thread_id;
  const chatId = ctx.chat?.id;
  if (typeof threadId === "number" && threadId > 1 && typeof chatId === "number") {
    try {
      const worker = await resolveReadyTopicWorker(chatId, threadId);
      if (worker) {
        const args = typeof ctx.match === "string" ? ctx.match.trim() : "";
        const targetDir = normalizeRemoteRelativePath(args || ".");
        const entries = await listRemoteWorkerFiles(worker, targetDir);
        const view = buildRemoteLsBrowseView(entries, targetDir);
        const sent = await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
        interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { menuKind: "ls", messageId: sent.message_id } });
        return;
      }
    } catch (error) {
      await ctx.reply(`❌ ${error instanceof Error ? error.message : t("ls.scan_error")}`);
      return;
    }
  }

  if (isContainerRuntime()) {
    await ctx.reply(t("runtime.container.command_unavailable"));
    return;
  }

  const projectRoot = getProjectRoot();
  if (!projectRoot) {
    await ctx.reply(t("bot.project_not_selected"));
    return;
  }

  const args = typeof ctx.match === "string" ? ctx.match.trim() : undefined;
  const targetDir = args || resolveInitialLsDirectory(ctx.from?.id);
  if (!targetDir) {
    await ctx.reply(t("bot.project_not_selected"));
    return;
  }

  if (!isWithinProjectRoot(targetDir)) {
    await ctx.reply(`❌ ${t("ls.access_denied")}`);
    return;
  }

  const view = await renderLsBrowseView(targetDir);
  if ("error" in view) {
    await ctx.reply(`❌ ${view.error}`);
    return;
  }

  rememberLsDirectory(ctx.from?.id, targetDir);

  if (!view.hasActions) {
    await ctx.reply(view.text, { parse_mode: "HTML" });
    return;
  }

  const message = await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  interactionManager.start({
    kind: "inline",
    expectedInput: "callback",
    metadata: {
      menuKind: "ls",
      messageId: message.message_id,
    },
  });
}

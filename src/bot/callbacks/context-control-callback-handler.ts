import { Context } from "grammy";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { alert, failure } from "./feedback.js";
import { clearActiveInlineMenu, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { runCoreSessionTask } from "../../core/native-core-service.js";

function callbackThreadId(ctx: Context): number | undefined {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_thread_id" in message)) return undefined;
  const value = (message as { message_thread_id?: number }).message_thread_id;
  return typeof value === "number" && value > 1 ? value : undefined;
}

export async function runContextCompaction(ctx: Context): Promise<void> {
  try {
    const session = getCurrentSession();
    if (!session) {
      clearActiveInlineMenu("context_session_missing");
      await alert(ctx, "context.no_active_session");
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery({ text: t("context.callback_compacting") });
    clearActiveInlineMenu("context_compact_confirmed");
    await ctx.deleteMessage().catch(() => {});
    const progressMessage = await ctx.reply(t("context.progress"));
    const threadId = callbackThreadId(ctx);
    if (threadId) await ctx.api.sendChatAction(ctx.chat!.id, "typing", { message_thread_id: threadId });
    else await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    const storedModel = getStoredModel();
    logger.debug(
      `[ContextHandler] Calling summarize with sessionID=${session.id}, directory=${session.directory}, model=${storedModel.providerID}/${storedModel.modelID}`,
    );

    const { error } = await runCoreSessionTask(
      session.id,
      session.directory,
      "session_summarize",
      ({ signal }) => opencodeClient.session.summarize({
        sessionID: session.id,
        directory: session.directory,
        providerID: storedModel.providerID,
        modelID: storedModel.modelID,
      }, { signal }),
      { timeoutMs: 15 * 60_000 },
    );

    if (error) {
      logger.error("[ContextHandler] Compact failed:", error);
      await ctx.api.editMessageText(ctx.chat!.id, progressMessage.message_id, t("context.error")).catch(() => {});
      return;
    }

    logger.info(`[ContextHandler] Session compacted: ${session.id}`);
    await ctx.api.editMessageText(ctx.chat!.id, progressMessage.message_id, t("context.success")).catch(() => {});
  } catch (err) {
    clearActiveInlineMenu("context_compact_error");
    logger.error("[ContextHandler] Compact exception:", err);
    await failure(ctx, "context.error");
    await ctx.deleteMessage().catch(() => {});
  }
}

/** Handle legacy Context confirmation callbacks. */
export async function handleCompactConfirm(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data || callbackQuery.data !== "compact:confirm") return false;
  if (!(await ensureActiveInlineMenu(ctx, "context"))) return true;
  logger.debug("[ContextHandler] Compact confirmed");
  await runContextCompaction(ctx);
  return true;
}

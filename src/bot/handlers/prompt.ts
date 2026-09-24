import { Bot, Context } from "grammy";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "../../opencode/client.js";
import { clearSession, getCurrentSession, setCurrentSession } from "../../app/services/session-service.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel, resolveCatalogModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";
import { stopEventListening } from "../../opencode/events.js";
import { interactionManager, clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { clearPausedSession } from "../../app/managers/paused-session-manager.js";
import { attachToSession, detachAttachedSession, markAttachedSessionBusy, markAttachedSessionIdle } from "../../app/services/attach-service.js";
import { externalUserInputSuppressionManager } from "../../app/managers/external-input-suppression-manager.js";
import { promptAttachment } from "../../app/managers/prompt-attachment-manager.js";
import { resolvePendingAttachments } from "../../app/services/prompt-attachment-service.js";
import { startSessionStallWatchdog, stopSessionStallWatchdog } from "../../app/services/session-stall-watchdog.js";
import { promptQueue } from "../../app/managers/prompt-queue-manager.js";
import { recoverSessionAfterError } from "../../app/services/session-error-recovery-service.js";
import type { ModelInfo } from "../../app/types/model.js";

export function clearPromptResponseMode(_sessionId: string): void {}
/** @deprecated Kept as a no-op for test/plugin compatibility after removing bot-layer stall recovery. */
export function __resetPromptRecoveryStateForTests(): void {}

async function resetMismatchedSessionContext(): Promise<void> {
  detachAttachedSession("session_mismatch_reset");
  stopEventListening();
  summaryAggregator.clear();
  foregroundSessionState.clearAll("session_mismatch_reset");
  assistantRunState.clearAll("session_mismatch_reset");
  clearAllInteractionState("session_mismatch_reset");
  clearSession();
  keyboardManager.clearContext();
  if (!pinnedMessageManager.isInitialized()) return;
  try { await pinnedMessageManager.clear(); } catch (err) { logger.error("[Bot] Failed to clear pinned message during session reset:", err); }
}

export interface ProcessPromptDeps { bot: Bot<Context>; ensureEventSubscription: (directory: string) => Promise<void>; }

async function retireAttachmentConfirmation(ctx: Context, messageId: number | undefined): Promise<void> {
  if (!messageId || !ctx.chat) return;
  await ctx.api.editMessageReplyMarkup(ctx.chat.id, messageId).catch((err) => logger.debug(`[PromptAttachment] Could not retire confirmation message ${messageId}:`, err));
}

async function handlePromptStartFailure(input: {
  bot: Bot<Context>;
  chatId: number;
  session: { id: string; directory: string };
  error: unknown;
  reason: string;
}): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  promptQueue.clear(input.reason, input.session.id);
  promptAttachment.clear(input.reason, input.session.id);
  clearPausedSession(input.session.id);
  clearAllInteractionState(input.reason);
  stopSessionStallWatchdog(input.session.id);
  foregroundSessionState.markIdle(input.session.id);
  await markAttachedSessionIdle(input.session.id);
  assistantRunState.clearRun(input.session.id, input.reason);
  keyboardManager.setPaused(false, input.session.id);
  await recoverSessionAfterError(input.session.id, input.session.directory, message);
  try {
    await keyboardManager.sendKeyboardUpdate(input.chatId, true, input.session.id);
  } catch (error) {
    logger.warn(`[Bot] Failed to restore keyboard after prompt start error: session=${input.session.id}`, error);
  }
  await input.bot.api.sendMessage(input.chatId, t("bot.prompt_send_error")).catch(() => {});
}

async function promptAsyncWithModelRecovery(promptOptions: { sessionID: string; directory: string; parts: Array<TextPartInput | FilePartInput>; model?: { providerID: string; modelID: string }; agent?: string; variant?: string }) {
  const first = await opencodeClient.session.promptAsync(promptOptions);
  if (!first.error || !promptOptions.model) return first;
  const detail = String((first.error as { name?: string; message?: string })?.message ?? first.error);
  const type = String((first.error as { name?: string })?.name ?? "");
  if (!/model\s+not\s+found|ProviderModelNotFoundError/i.test(`${type} ${detail}`)) return first;
  logger.warn(`[Bot] Explicit model rejected by OpenCode; refreshing catalog and retrying without a stale model: ${promptOptions.model.providerID}/${promptOptions.model.modelID}`);
  const refreshed = await resolveCatalogModel(promptOptions.model.providerID, promptOptions.model.modelID, { forceRefresh: true });
  if (refreshed) {
    promptOptions.model = { providerID: refreshed.providerID, modelID: refreshed.modelID };
    const retry = await opencodeClient.session.promptAsync(promptOptions);
    if (!retry.error) return retry;
  }
  const retryWithoutModel = { ...promptOptions };
  delete retryWithoutModel.model;
  delete retryWithoutModel.variant;
  return opencodeClient.session.promptAsync(retryWithoutModel);
}

export async function processUserPrompt(ctx: Context, text: string, deps: ProcessPromptDeps, fileParts: FilePartInput[] = [], modelOverride?: ModelInfo): Promise<boolean> {
  const { bot, ensureEventSubscription } = deps;
  const currentProject = getCurrentProject();
  if (!currentProject) { await ctx.reply(t("bot.project_not_selected")); return false; }
  let currentSession = getCurrentSession();
  let createdNewSession = false;
  if (currentSession && currentSession.directory !== currentProject.worktree) { await resetMismatchedSessionContext(); await ctx.reply(t("bot.session_reset_project_mismatch")); return false; }
  if (!currentSession) {
    await ctx.reply(t("bot.creating_session"));
    const { data: session, error } = await opencodeClient.session.create({ directory: currentProject.worktree });
    if (error || !session) { await ctx.reply(t("bot.create_session_error")); return false; }
    logger.info(`[Bot] Created new session: id=${session.id}, title="${session.title}", project=${currentProject.worktree}`);
    currentSession = { id: session.id, title: session.title, directory: currentProject.worktree };
    setCurrentSession(currentSession);
    await ingestSessionInfoForCache(session);
    createdNewSession = true;
  }
  const attachResult = await attachToSession({ bot, chatId: ctx.chat!.id, session: currentSession, ensureEventSubscription });
  if (createdNewSession) {
    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const currentModel = getStoredModel();
    keyboardManager.updateAgent(currentAgent);
    const contextInfo = keyboardManager.getContextInfo();
    const variantName = formatVariantForButton(currentModel.variant || "default");
    await ctx.reply(t("bot.session_created", { title: currentSession.title }), { reply_markup: createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName) });
  }
  const locallyBusy =
    assistantRunState.hasActiveRun(currentSession.id) ||
    foregroundSessionState.getBusySessions().some((session) => session.sessionId === currentSession!.id);
  if (attachResult.busy || locallyBusy) { await ctx.reply(t("bot.session_busy")); return false; }
  try {
    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const storedModel = modelOverride ?? getStoredModel();
    const parts: Array<TextPartInput | FilePartInput> = [];
    if (text.trim()) parts.push({ type: "text", text });
    parts.push(...fileParts);
    const pendingAttachment = promptAttachment.get();
    const attachmentParts = await resolvePendingAttachments(currentSession.directory);
    if (attachmentParts.length) parts.push(...attachmentParts); else if (pendingAttachment) await ctx.reply(t("attachment.invalid"));
    if (pendingAttachment) { promptAttachment.clear("consumed"); interactionManager.clear("attachment_consumed"); await retireAttachmentConfirmation(ctx, pendingAttachment.confirmationMessageId); }
    if (parts.length === 0 || parts.every((p) => p.type === "file")) if (fileParts.length > 0) parts.unshift({ type: "text", text: fileParts.length === 1 ? "See attached file" : "See attached files" });
    if (parts.length === 0) {
      await ctx.reply(t("bot.empty_prompt"));
      return false;
    }
    const promptOptions: { sessionID: string; directory: string; parts: Array<TextPartInput | FilePartInput>; model?: { providerID: string; modelID: string }; agent?: string; variant?: string } = { sessionID: currentSession.id, directory: currentSession.directory, parts, agent: currentAgent };
    if (storedModel.providerID && storedModel.modelID) { promptOptions.model = { providerID: storedModel.providerID, modelID: storedModel.modelID }; promptOptions.variant = storedModel.variant; }
    const promptErrorLogContext = { sessionId: currentSession.id, telegramChatId: ctx.chat?.id, directory: currentSession.directory, agent: currentAgent || "default", modelProvider: storedModel.providerID || "OpenCode/default", modelId: storedModel.modelID || "default", variant: storedModel.variant || "default", promptLength: text.length, fileCount: parts.filter((p) => p.type === "file").length };
    logger.info(`[Bot] Dispatching prompt: session=${currentSession.id} model=${storedModel.providerID && storedModel.modelID ? `${storedModel.providerID}/${storedModel.modelID}` : "OpenCode/default"} agent=${currentAgent || "default"} textLength=${text.length} files=${parts.filter((p) => p.type === "file").length}`);
    foregroundSessionState.markBusy(currentSession.id, currentSession.directory);
    await markAttachedSessionBusy(currentSession.id);
    assistantRunState.startRun(currentSession.id, { startedAt: Date.now(), configuredAgent: currentAgent, configuredProviderID: storedModel.providerID, configuredModelID: storedModel.modelID });
    startSessionStallWatchdog({
      sessionId: currentSession.id,
      directory: currentSession.directory,
      model: storedModel.providerID && storedModel.modelID ? `${storedModel.providerID}/${storedModel.modelID}` : "OpenCode/default",
    });
    if (text.trim()) externalUserInputSuppressionManager.register(currentSession.id, text);

    // Start inference before cosmetic Telegram keyboard work. A slow/rate-limited
    // Telegram edit must never delay the provider request itself.
    safeBackgroundTask({
      taskName: "session.promptAsync",
      task: () => promptAsyncWithModelRecovery(promptOptions),
      onSuccess: async ({ error }) => {
        if (!error) {
          logger.info(`[Bot] promptAsync accepted by OpenCode: session=${currentSession!.id} model=${storedModel.providerID && storedModel.modelID ? `${storedModel.providerID}/${storedModel.modelID}` : "OpenCode/default"}`);
          return;
        }
        logger.error("[Bot] OpenCode API returned an error for session.promptAsync", promptErrorLogContext);
        logger.error("[Bot] session.promptAsync error details:", formatErrorDetails(error, 6000));
        await handlePromptStartFailure({ bot, chatId: ctx.chat!.id, session: currentSession!, error, reason: "session_prompt_api_error" });
      },
      onError: async (error) => {
        logger.error("[Bot] session.promptAsync background task failed", promptErrorLogContext);
        logger.error("[Bot] session.promptAsync background failure details:", formatErrorDetails(error, 6000));
        await handlePromptStartFailure({ bot, chatId: ctx.chat!.id, session: currentSession!, error, reason: "session_prompt_background_error" });
      },
    });

    void Promise.resolve()
      .then(() => keyboardManager.sendKeyboardUpdate(ctx.chat!.id, true, currentSession!.id))
      .catch((error) => {
        logger.warn(`[Bot] Busy keyboard update failed without blocking prompt dispatch: session=${currentSession!.id}`, error);
      });
    return true;
  } catch (err) {
    if (currentSession) { foregroundSessionState.markIdle(currentSession.id); await markAttachedSessionIdle(currentSession.id); assistantRunState.clearRun(currentSession.id, "session_prompt_handler_error"); void keyboardManager.sendKeyboardUpdate(ctx.chat!.id, true, currentSession.id); }
    logger.error("Error in prompt handler:", err);
    if (interactionManager.getSnapshot()) clearAllInteractionState("message_handler_error");
    await ctx.reply(t("error.generic"));
    return false;
  }
}
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
import { attachToSession, detachAttachedSession, markAttachedSessionBusy, markAttachedSessionIdle } from "../../app/services/attach-service.js";
import { externalUserInputSuppressionManager } from "../../app/managers/external-input-suppression-manager.js";
import { promptAttachment } from "../../app/managers/prompt-attachment-manager.js";
import { resolvePendingAttachment } from "../../app/services/prompt-attachment-service.js";
import { startSessionStallWatchdog, type StalledSessionInfo } from "../../app/services/session-stall-watchdog.js";
import type { ModelInfo } from "../../app/types/model.js";

const MAX_AUTO_STALL_RETRIES = 1;
const STALL_RECOVERY_PROMPT =
  "The previous attempt on this task made no visible progress for several minutes and was aborted automatically. " +
  "Continue the same task, but use a different approach or diagnostic strategy than before — the previous approach did not make progress.";

export function clearPromptResponseMode(_sessionId: string): void {}
let botInstance: Bot<Context> | null = null;
let telegramChatId: number | null = null;
const autoRecoveryInFlight = new Set<string>();
export function getPromptBotInstance(): Bot<Context> | null { return botInstance; }
export function getPromptChatId(): number | null { return telegramChatId; }
export function __resetPromptRecoveryStateForTests(): void { autoRecoveryInFlight.clear(); }

async function isSessionBusy(sessionId: string, directory: string): Promise<boolean> {
  try {
    if (assistantRunState.hasActiveRun(sessionId)) return true;
    if (foregroundSessionState.getBusySessions().some((session) => session.sessionId === sessionId)) return true;
    const { data, error } = await opencodeClient.session.status({ directory });
    if (error || !data) return false;
    const sessionStatus = (data as Record<string, { type?: string }>)[sessionId];
    return sessionStatus?.type === "busy" || sessionStatus?.type === "retry";
  } catch (err) {
    logger.warn("[Bot] Error checking session status before prompt:", err);
    return assistantRunState.hasActiveRun(sessionId) || foregroundSessionState.getBusySessions().some((session) => session.sessionId === sessionId);
  }
}

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

async function dispatchRecoveryPrompt(info: StalledSessionInfo): Promise<void> {
  const session = { id: info.sessionId, directory: info.directory };
  const attempt = info.attempt + 1;
  const bot = botInstance;
  const chatId = telegramChatId;
  try {
    const currentAgent = info.agent ?? await resolveProjectAgent(getStoredAgent());
    const storedModel = getStoredModel();
    const recoveryModel = info.modelConfig ?? (storedModel.providerID && storedModel.modelID ? { providerID: storedModel.providerID, modelID: storedModel.modelID } : undefined);
    const recoveryVariant = info.variant ?? storedModel.variant;
    const promptOptions: { sessionID: string; directory: string; parts: Array<TextPartInput | FilePartInput>; model?: { providerID: string; modelID: string }; agent?: string; variant?: string } = {
      sessionID: session.id,
      directory: session.directory,
      parts: [{ type: "text", text: STALL_RECOVERY_PROMPT }],
      agent: currentAgent,
    };
    if (recoveryModel) {
      promptOptions.model = recoveryModel;
      promptOptions.variant = recoveryVariant;
    }
    foregroundSessionState.markBusy(session.id, session.directory);
    await markAttachedSessionBusy(session.id);
    assistantRunState.startRun(session.id, {
      startedAt: Date.now(),
      configuredAgent: currentAgent,
      configuredProviderID: recoveryModel?.providerID,
      configuredModelID: recoveryModel?.modelID,
    });
    startSessionStallWatchdog({
      sessionId: session.id,
      directory: session.directory,
      model: recoveryModel ? `${recoveryModel.providerID}/${recoveryModel.modelID}` : "OpenCode/default",
      agent: currentAgent,
      modelConfig: recoveryModel,
      variant: recoveryVariant,
      attempt,
      onStalled: handleSessionStalled,
    });
    if (chatId !== null) await keyboardManager.sendKeyboardUpdate(chatId);
    logger.warn(`[StallWatchdog] Dispatching auto-recovery prompt: session=${session.id}, attempt=${attempt}`);
    safeBackgroundTask({
      taskName: "session.promptAsync.stall_recovery",
      task: () => promptAsyncWithModelRecovery(promptOptions),
      onSuccess: ({ error }) => {
        if (!error) {
          logger.info(`[StallWatchdog] Auto-recovery prompt accepted by OpenCode: session=${session.id}, attempt=${attempt}`);
          return;
        }
        foregroundSessionState.markIdle(session.id);
        void markAttachedSessionIdle(session.id);
        assistantRunState.clearRun(session.id, "stall_recovery_prompt_api_error");
        if (chatId !== null) void keyboardManager.sendKeyboardUpdate(chatId, true);
        logger.error(`[StallWatchdog] OpenCode API returned an error for the auto-recovery prompt: session=${session.id}, attempt=${attempt}`);
        logger.error("[StallWatchdog] Auto-recovery prompt error details:", formatErrorDetails(error, 6000));
        if (bot && chatId !== null) void bot.api.sendMessage(chatId, t("bot.prompt_send_error")).catch(() => {});
      },
      onError: (error) => {
        foregroundSessionState.markIdle(session.id);
        void markAttachedSessionIdle(session.id);
        assistantRunState.clearRun(session.id, "stall_recovery_prompt_background_error");
        if (chatId !== null) void keyboardManager.sendKeyboardUpdate(chatId, true);
        logger.error(`[StallWatchdog] Auto-recovery prompt background task failed: session=${session.id}, attempt=${attempt}`);
        logger.error("[StallWatchdog] Auto-recovery background failure details:", formatErrorDetails(error, 6000));
        if (bot && chatId !== null) void bot.api.sendMessage(chatId, t("bot.prompt_send_error")).catch(() => {});
      },
    });
  } catch (error) {
    logger.error(`[StallWatchdog] Failed to dispatch auto-recovery prompt: session=${session.id}, attempt=${attempt}`, error);
    if (bot && chatId !== null) await bot.api.sendMessage(chatId, t("bot.prompt_send_error")).catch(() => {});
  }
}

async function handleSessionStalled(info: StalledSessionInfo): Promise<void> {
  const bot = botInstance;
  const chatId = telegramChatId;
  if (info.attempt > MAX_AUTO_STALL_RETRIES) {
    logger.warn(`[StallWatchdog] Giving up after ${info.attempt} stalled attempt(s): session=${info.sessionId}`);
    if (bot && chatId !== null) await bot.api.sendMessage(chatId, t("stop.success")).catch(() => {});
    return;
  }
  const currentSession = getCurrentSession();
  if (!currentSession || currentSession.id !== info.sessionId) {
    logger.info(`[StallWatchdog] Skipping auto-recovery; session is no longer active: session=${info.sessionId}`);
    return;
  }
  if (autoRecoveryInFlight.has(info.sessionId)) {
    logger.warn(`[StallWatchdog] Skipping duplicate auto-recovery: session=${info.sessionId}`);
    return;
  }
  if (await isSessionBusy(info.sessionId, info.directory)) {
    logger.info(`[StallWatchdog] Skipping auto-recovery; session became busy again: session=${info.sessionId}`);
    return;
  }
  autoRecoveryInFlight.add(info.sessionId);
  try {
    if (bot && chatId !== null) await bot.api.sendMessage(chatId, t("progress.compact.retrying")).catch(() => {});
    await dispatchRecoveryPrompt(info);
  } finally {
    autoRecoveryInFlight.delete(info.sessionId);
  }
}

export async function processUserPrompt(ctx: Context, text: string, deps: ProcessPromptDeps, fileParts: FilePartInput[] = [], modelOverride?: ModelInfo): Promise<boolean> {
  const { bot, ensureEventSubscription } = deps;
  const currentProject = getCurrentProject();
  if (!currentProject) { await ctx.reply(t("bot.project_not_selected")); return false; }
  botInstance = bot; telegramChatId = ctx.chat!.id;
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
  await attachToSession({ bot, chatId: ctx.chat!.id, session: currentSession, ensureEventSubscription });
  if (createdNewSession) {
    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const currentModel = getStoredModel();
    keyboardManager.updateAgent(currentAgent);
    const contextInfo = keyboardManager.getContextInfo();
    const variantName = formatVariantForButton(currentModel.variant || "default");
    await ctx.reply(t("bot.session_created", { title: currentSession.title }), { reply_markup: createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName) });
  }
  if (autoRecoveryInFlight.has(currentSession.id)) { await ctx.reply(t("bot.session_busy")); return false; }
  if (await isSessionBusy(currentSession.id, currentSession.directory)) { await ctx.reply(t("bot.session_busy")); return false; }
  try {
    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const storedModel = modelOverride ?? getStoredModel();
    const parts: Array<TextPartInput | FilePartInput> = [];
    if (text.trim()) parts.push({ type: "text", text });
    parts.push(...fileParts);
    const pendingAttachment = promptAttachment.get();
    const attachmentPart = await resolvePendingAttachment(currentSession.directory);
    if (attachmentPart) parts.push(attachmentPart); else if (pendingAttachment) await ctx.reply(t("attachment.invalid"));
    if (pendingAttachment) { promptAttachment.clear("consumed"); interactionManager.clear("attachment_consumed"); await retireAttachmentConfirmation(ctx, pendingAttachment.confirmationMessageId); }
    if (parts.length === 0 || parts.every((p) => p.type === "file")) if (fileParts.length > 0) parts.unshift({ type: "text", text: fileParts.length === 1 ? "See attached file" : "See attached files" });
    const promptOptions: { sessionID: string; directory: string; parts: Array<TextPartInput | FilePartInput>; model?: { providerID: string; modelID: string }; agent?: string; variant?: string } = { sessionID: currentSession.id, directory: currentSession.directory, parts, agent: currentAgent };
    if (storedModel.providerID && storedModel.modelID) { promptOptions.model = { providerID: storedModel.providerID, modelID: storedModel.modelID }; promptOptions.variant = storedModel.variant; }
    const promptErrorLogContext = { sessionId: currentSession.id, telegramChatId: ctx.chat?.id, directory: currentSession.directory, agent: currentAgent || "default", modelProvider: storedModel.providerID || "OpenCode/default", modelId: storedModel.modelID || "default", variant: storedModel.variant || "default", promptLength: text.length, fileCount: parts.filter((p) => p.type === "file").length };
    logger.info(`[Bot] Dispatching prompt: session=${currentSession.id} model=${storedModel.providerID && storedModel.modelID ? `${storedModel.providerID}/${storedModel.modelID}` : "OpenCode/default"} agent=${currentAgent || "default"} textLength=${text.length} files=${parts.filter((p) => p.type === "file").length}`);
    foregroundSessionState.markBusy(currentSession.id, currentSession.directory);
    await markAttachedSessionBusy(currentSession.id);
    assistantRunState.startRun(currentSession.id, { startedAt: Date.now(), configuredAgent: currentAgent, configuredProviderID: storedModel.providerID, configuredModelID: storedModel.modelID });
    startSessionStallWatchdog({ sessionId: currentSession.id, directory: currentSession.directory, model: storedModel.providerID && storedModel.modelID ? `${storedModel.providerID}/${storedModel.modelID}` : "OpenCode/default", agent: currentAgent, modelConfig: storedModel.providerID && storedModel.modelID ? { providerID: storedModel.providerID, modelID: storedModel.modelID } : undefined, variant: storedModel.variant, attempt: 1, onStalled: handleSessionStalled });
    await keyboardManager.sendKeyboardUpdate(ctx.chat!.id);
    if (text.trim()) externalUserInputSuppressionManager.register(currentSession.id, text);
    safeBackgroundTask({ taskName: "session.promptAsync", task: () => promptAsyncWithModelRecovery(promptOptions), onSuccess: ({ error }) => { if (!error) { logger.info(`[Bot] promptAsync accepted by OpenCode: session=${currentSession!.id} model=${storedModel.providerID && storedModel.modelID ? `${storedModel.providerID}/${storedModel.modelID}` : "OpenCode/default"}`); return; } foregroundSessionState.markIdle(currentSession!.id); void markAttachedSessionIdle(currentSession!.id); assistantRunState.clearRun(currentSession!.id, "session_prompt_api_error"); void keyboardManager.sendKeyboardUpdate(ctx.chat!.id, true); logger.error("[Bot] OpenCode API returned an error for session.promptAsync", promptErrorLogContext); logger.error("[Bot] session.promptAsync error details:", formatErrorDetails(error, 6000)); void bot.api.sendMessage(ctx.chat!.id, t("bot.prompt_send_error")).catch(() => {}); }, onError: (error) => { foregroundSessionState.markIdle(currentSession!.id); void markAttachedSessionIdle(currentSession!.id); assistantRunState.clearRun(currentSession!.id, "session_prompt_background_error"); void keyboardManager.sendKeyboardUpdate(ctx.chat!.id, true); logger.error("[Bot] session.promptAsync background task failed", promptErrorLogContext); logger.error("[Bot] session.promptAsync background failure details:", formatErrorDetails(error, 6000)); void bot.api.sendMessage(ctx.chat!.id, t("bot.prompt_send_error")).catch(() => {}); } });
    return true;
  } catch (err) {
    if (currentSession) { foregroundSessionState.markIdle(currentSession.id); await markAttachedSessionIdle(currentSession.id); assistantRunState.clearRun(currentSession.id, "session_prompt_handler_error"); void keyboardManager.sendKeyboardUpdate(ctx.chat!.id, true); }
    logger.error("Error in prompt handler:", err);
    if (interactionManager.getSnapshot()) clearAllInteractionState("message_handler_error");
    await ctx.reply(t("error.generic"));
    return false;
  }
}

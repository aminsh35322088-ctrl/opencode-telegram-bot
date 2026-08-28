import { Bot, Context } from "grammy";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "../../opencode/client.js";
import { clearSession, getCurrentSession, setCurrentSession } from "../../app/services/session-service.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
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
import { externalUserInputSuppressionManager } from "../../app/managers/external-user-input-suppression-manager.js";
import { promptAttachment } from "../../app/managers/prompt-attachment-manager.js";
import { resolvePendingAttachment } from "../../app/services/prompt-attachment-service.js";

/** Legacy reconciliation hook retained as a no-op after audio reply removal. */
export function clearPromptResponseMode(_sessionId: string): void {}

let botInstance: Bot<Context> | null = null;
let chatIdInstance: number | null = null;

export function getPromptBotInstance(): Bot<Context> | null { return botInstance; }
export function getPromptChatId(): number | null { return chatIdInstance; }

async function isSessionBusy(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.session.status({ directory });
    if (error || !data) return false;
    const sessionStatus = (data as Record<string, { type?: string }>)[sessionId];
    return sessionStatus?.type === "busy";
  } catch (err) {
    logger.warn("[Bot] Error checking session status before prompt:", err);
    return false;
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
  try { await pinnedMessageManager.clear(); }
  catch (err) { logger.error("[Bot] Failed to clear pinned message during session reset:", err); }
}

export interface ProcessPromptDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

async function retireAttachmentConfirmation(ctx: Context, messageId: number | undefined): Promise<void> {
  if (!messageId || !ctx.chat) return;
  await ctx.api.editMessageReplyMarkup(ctx.chat.id, messageId).catch((err) => {
    logger.debug(`[PromptAttachment] Could not retire confirmation message ${messageId}:`, err);
  });
}

export async function processUserPrompt(ctx: Context, text: string, deps: ProcessPromptDeps, fileParts: FilePartInput[] = []): Promise<boolean> {
  const { bot, ensureEventSubscription } = deps;
  const currentProject = getCurrentProject();
  if (!currentProject) { await ctx.reply(t("bot.project_not_selected")); return false; }

  botInstance = bot;
  chatIdInstance = ctx.chat!.id;
  let currentSession = getCurrentSession();
  let createdNewSession = false;

  if (currentSession && currentSession.directory !== currentProject.worktree) {
    await resetMismatchedSessionContext();
    await ctx.reply(t("bot.session_reset_project_mismatch"));
    return false;
  }

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
    const keyboard = createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName);
    await ctx.reply(t("bot.session_created", { title: currentSession.title }), { reply_markup: keyboard });
  }

  if (await isSessionBusy(currentSession.id, currentSession.directory)) {
    await ctx.reply(t("bot.session_busy"));
    return false;
  }

  try {
    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const storedModel = getStoredModel();
    const parts: Array<TextPartInput | FilePartInput> = [];
    if (text.trim()) parts.push({ type: "text", text });
    parts.push(...fileParts);

    const pendingAttachment = promptAttachment.get();
    const attachmentPart = await resolvePendingAttachment(currentSession.directory);
    if (attachmentPart) parts.push(attachmentPart);
    else if (pendingAttachment) await ctx.reply(t("attachment.invalid"));
    if (pendingAttachment) {
      promptAttachment.clear("consumed");
      interactionManager.clear("attachment_consumed");
      await retireAttachmentConfirmation(ctx, pendingAttachment.confirmationMessageId);
    }
    if (parts.length === 0 || parts.every((p) => p.type === "file")) {
      if (fileParts.length > 0) parts.unshift({ type: "text", text: fileParts.length === 1 ? "See attached file" : "See attached files" });
    }

    const promptOptions: { sessionID: string; directory: string; parts: Array<TextPartInput | FilePartInput>; model?: { providerID: string; modelID: string }; agent?: string; variant?: string } = { sessionID: currentSession.id, directory: currentSession.directory, parts, agent: currentAgent };
    if (storedModel.providerID && storedModel.modelID) {
      promptOptions.model = { providerID: storedModel.providerID, modelID: storedModel.modelID };
      if (storedModel.variant) promptOptions.variant = storedModel.variant;
    }

    const promptErrorLogContext = { sessionId: currentSession.id, directory: currentSession.directory, agent: currentAgent || "default", modelProvider: storedModel.providerID || "default", modelId: storedModel.modelID || "default", variant: storedModel.variant || "default", promptLength: text.length, fileCount: parts.filter((p) => p.type === "file").length };
    foregroundSessionState.markBusy(currentSession.id, currentSession.directory);
    await markAttachedSessionBusy(currentSession.id);
    assistantRunState.startRun(currentSession.id, { startedAt: Date.now(), configuredAgent: currentAgent, configuredProviderID: storedModel.providerID, configuredModelID: storedModel.modelID });
    await keyboardManager.sendKeyboardUpdate(ctx.chat!.id);
    if (text.trim()) externalUserInputSuppressionManager.register(currentSession.id, text);

    safeBackgroundTask({
      taskName: "session.promptAsync",
      task: () => opencodeClient.session.promptAsync(promptOptions),
      onSuccess: ({ error }) => {
        if (!error) return;
        foregroundSessionState.markIdle(currentSession.id);
        void markAttachedSessionIdle(currentSession.id);
        assistantRunState.clearRun(currentSession.id, "session_prompt_api_error");
        logger.error("[Bot] OpenCode API returned an error for session.promptAsync", promptErrorLogContext);
        logger.error("[Bot] session.promptAsync error details:", formatErrorDetails(error, 6000));
        void bot.api.sendMessage(ctx.chat!.id, t("bot.prompt_send_error")).catch(() => {});
      },
      onError: (error) => {
        foregroundSessionState.markIdle(currentSession.id);
        void markAttachedSessionIdle(currentSession.id);
        assistantRunState.clearRun(currentSession.id, "session_prompt_background_error");
        logger.error("[Bot] session.promptAsync background task failed", promptErrorLogContext);
        logger.error("[Bot] session.promptAsync background failure details:", formatErrorDetails(error, 6000));
        void bot.api.sendMessage(ctx.chat!.id, t("bot.prompt_send_error")).catch(() => {});
      },
    });
    return true;
  } catch (err) {
    if (currentSession) {
      foregroundSessionState.markIdle(currentSession.id);
      await markAttachedSessionIdle(currentSession.id);
      assistantRunState.clearRun(currentSession.id, "session_prompt_handler_error");
    }
    logger.error("Error in prompt handler:", err);
    if (interactionManager.getSnapshot()) clearAllInteractionState("message_handler_error");
    await ctx.reply(t("error.generic"));
    return false;
  }
}

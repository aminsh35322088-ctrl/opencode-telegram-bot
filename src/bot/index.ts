import { Bot, Context } from "grammy";
import { readFile, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import { getCurrentProject } from "../app/stores/settings-store.js";
import { getCurrentSession, setCurrentSession } from "../app/services/session-service.js";
import { findTelegramTopicBindingBySession, findTelegramTopicBindingByThread } from "../app/services/telegram-topic-store.js";
import { attachManager } from "../app/managers/attach-manager.js";
import { clearAllInteractionState, interactionManager } from "../app/managers/interaction-manager.js";
import { configureAttachPresentation, restoreAttachedCurrentSession } from "../app/services/attach-service.js";
import { opencodeReadyLifecycle } from "../opencode/ready-lifecycle.js";
import { logger } from "../utils/logger.js";
import { safeBackgroundTask } from "../utils/safe-background-task.js";
import { withTelegramRateLimitRetry } from "../utils/telegram-rate-limit-retry.js";
import { registerCallbackRouter } from "./callbacks/callback-router.js";
import { initializePromptQueueDispatch } from "./handlers/prompt-queue-dispatch.js";
import { authMiddleware } from "./middleware/auth.js";
import { inboundRateLimitMiddleware } from "./middleware/inbound-rate-limit.js";
import { interactionGuardMiddleware } from "./middleware/interaction-guard.js";
import { staleUpdateMiddleware } from "./middleware/stale-update.js";
import { ensureCommandsInitialized, registerCommandRouter } from "./routers/command-router.js";
import { registerMessageRouter } from "./routers/message-router.js";
import { createEventSubscriptionService, type BotEventSubscriptionService } from "./services/event-subscription-service.js";
import { createAttachPresentation } from "./services/attach-presentation.js";
import { createTelegramBotOptions } from "./telegram-client-options.js";
import { BOT_COMMANDS } from "./commands/definitions.js";
import { MODEL_BUTTON_TEXT_PATTERN } from "./message-patterns.js";
import { showModelCenterMenu } from "./menus/model-center-menu.js";
import { closeActiveInlineMenu } from "./menus/inline-menu.js";
import { assistantRunState } from "../app/managers/assistant-run-state-manager.js";
import { t } from "../i18n/index.js";
import { registerTelegramTopicDeleteHandlers } from "./services/telegram-topic-delete-handler.js";
import {
  createTopicAwareBot,
  getActiveTelegramTopic,
  setActiveTelegramTopic,
  setTelegramTopicRuntimeDependencies,
} from "./services/telegram-topic-runtime.js";

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeReadyRestore: (() => void) | null = null;
const eventSubscriptionService: BotEventSubscriptionService = createEventSubscriptionService();
const VERSION_FILE = "/app/.opencode-version";
const LAST_NOTIFIED_VERSION_FILE = "/data/.last-opencode-notified-version";
const TRANSIENT_RETRY_SAFE_TELEGRAM_METHODS = new Set(["editMessageReplyMarkup", "editMessageText", "sendChatAction", "sendMessageDraft", "sendRichMessageDraft"]);
interface TelegramApiErrorResponse { ok: false; error_code: number; description: string; parameters?: object; }
class TelegramApiResponseError extends Error { constructor(readonly response: TelegramApiErrorResponse) { super(response.description ?? "Telegram API request failed"); Object.assign(this, response); } }
export function shouldRetryTelegramServerError(method: string): boolean { return TRANSIENT_RETRY_SAFE_TELEGRAM_METHODS.has(method); }
function isTelegramApiErrorResponse(response: unknown): response is TelegramApiErrorResponse { return typeof response === "object" && response !== null && Reflect.get(response, "ok") === false && typeof Reflect.get(response, "error_code") === "number" && typeof Reflect.get(response, "description") === "string"; }
async function notifyOpenCodeUpdate(bot: Bot<Context>): Promise<void> { try { const currentVersion = (await readFile(VERSION_FILE, "utf8")).trim(); if (!currentVersion) return; let previousVersion = ""; try { previousVersion = (await readFile(LAST_NOTIFIED_VERSION_FILE, "utf8")).trim(); } catch { /* first boot */ } if (!previousVersion) { await writeFile(LAST_NOTIFIED_VERSION_FILE, `${currentVersion}\n`, "utf8"); return; } if (previousVersion === currentVersion) return; await bot.api.sendMessage(config.telegram.allowedUserId, `🚀 <b>OpenCode Updated</b>\n\n${previousVersion} → <b>${currentVersion}</b>\n\n🟢 The new version is installed and ready to use.`, { parse_mode: "HTML" }); await writeFile(LAST_NOTIFIED_VERSION_FILE, `${currentVersion}\n`, "utf8"); logger.info(`[Bot] Notified user about OpenCode update: ${previousVersion} -> ${currentVersion}`); } catch (error) { logger.warn("[Bot] Could not send OpenCode update notification:", error); } }
function registerCanonicalModelKeyboard(bot: Bot<Context>): void {
  bot.hears(MODEL_BUTTON_TEXT_PATTERN, async (ctx) => {
    if (assistantRunState.hasActiveRuns()) {
      await ctx.reply(t("interaction.blocked.finish_current"));
      return;
    }
    const activeInteraction = interactionManager.getSnapshot();
    if (activeInteraction?.kind === "inline") {
      await closeActiveInlineMenu(ctx, "model-keyboard-navigation");
    } else if (activeInteraction) {
      await ctx.reply(t("interaction.blocked.finish_current"));
      return;
    }
    try {
      await showModelCenterMenu(ctx);
    } catch (error) {
      logger.error("[Bot] Error opening Model Center from persistent keyboard:", error);
      await ctx.reply("❌ Could not open Model Center. Please try again.");
    }
  });
}

async function resolveInboundTelegramTopic(ctx: Context, bot: Bot<Context>): Promise<void> {
  const chatId = ctx.chat?.id;
  const message = (ctx.message ?? ctx.callbackQuery?.message) as { message_thread_id?: number } | undefined;
  const threadId = message?.message_thread_id;
  if (typeof chatId !== "number") return;

  if (typeof threadId !== "number") {
    if (getActiveTelegramTopic(chatId)) setActiveTelegramTopic(null);
    return;
  }

  const binding = await findTelegramTopicBindingByThread(chatId, threadId);
  if (!binding) {
    if (getActiveTelegramTopic(chatId)?.threadId === threadId) setActiveTelegramTopic(null);
    return;
  }

  setCurrentSession({
    id: binding.sessionId,
    title: binding.title ?? "Telegram Topic",
    directory: binding.directory,
  });
  setActiveTelegramTopic({ chatId, threadId });
  eventSubscriptionService.setTelegramContext(
    createTopicAwareBot(bot, { chatId, threadId }),
    chatId,
  );
  logger.debug(
    `[TelegramTopics] Routed inbound update to Topic: session=${binding.sessionId}, chat=${chatId}, thread=${threadId}`,
  );
}

export function createBot(): Bot<Context> { clearAllInteractionState("bot_startup"); attachManager.clear("bot_startup"); eventSubscriptionService.clearRuntimeState("bot_startup"); setActiveTelegramTopic(null); if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } const bot = new Bot(config.telegram.token, createTelegramBotOptions(config.telegram)); const eventBot = createTopicAwareBot(bot); configureAttachPresentation(createAttachPresentation()); const setTelegramContext = (contextBot: Bot<Context>, chatId: number) => eventSubscriptionService.setTelegramContext(contextBot, chatId); const ensureEventSubscription = eventSubscriptionService.ensureEventSubscription.bind(eventSubscriptionService); setTelegramTopicRuntimeDependencies({ ensureEventSubscription }); setTelegramContext(eventBot, config.telegram.allowedUserId); initializePromptQueueDispatch({ bot, ensureEventSubscription }); unsubscribeReadyRestore?.(); unsubscribeReadyRestore = opencodeReadyLifecycle.onReady(async (reason) => { const currentSession = getCurrentSession(); if (currentSession) { const binding = await findTelegramTopicBindingBySession(config.telegram.allowedUserId, currentSession.id); if (binding && binding.directory === currentSession.directory) { setActiveTelegramTopic({ chatId: config.telegram.allowedUserId, threadId: binding.threadId }); await ensureEventSubscription(currentSession.directory); logger.info(`[Bot] Restored bound session topic after OpenCode ready: session=${currentSession.id}, thread=${binding.threadId}, reason=${reason}`); return; } logger.info(`[Bot] Skipping main-chat session restore; current session has no Telegram topic binding: session=${currentSession.id}`); return; } const restored = await restoreAttachedCurrentSession({ bot, chatId: config.telegram.allowedUserId, ensureEventSubscription, forceFullRestore: true }); if (restored) { logger.info(`[Bot] Restored followed session after OpenCode ready: reason=${reason}`); return; } const currentProject = getCurrentProject(); if (config.bot.trackBackgroundSessions && currentProject?.worktree) { await ensureEventSubscription(currentProject.worktree); logger.info(`[Bot] Started background session tracking after OpenCode ready: reason=${reason}`); } }); void notifyOpenCodeUpdate(bot); let heartbeatCounter = 0; heartbeatTimer = setInterval(() => { heartbeatCounter++; if (heartbeatCounter % 6 === 0) logger.debug(`[Bot] Heartbeat #${heartbeatCounter} - event loop alive`); }, 5000); let lastGetUpdatesTime = Date.now(); bot.api.config.use(async (prev, method, payload, signal) => { if (method === "getUpdates") { const now = Date.now(); logger.debug(`[Bot API] getUpdates called (${now - lastGetUpdatesTime}ms since last)`); lastGetUpdatesTime = now; return prev(method, payload, signal); } if (method === "sendMessage") logger.debug(`[Bot API] sendMessage to chat ${(payload as { chat_id?: number }).chat_id}`); try { return await withTelegramRateLimitRetry(async () => { const response = await prev(method, payload, signal); if (isTelegramApiErrorResponse(response)) throw new TelegramApiResponseError(response); return response; }, { maxRetries: 5, retryTransientServerErrors: shouldRetryTelegramServerError(method), onRetry: ({ attempt, retryAfterMs, error }) => logger.warn(`[Bot API] Retryable Telegram error on ${method}, retrying in ${retryAfterMs}ms (attempt=${attempt})`, error) }); } catch (error) { if (error instanceof TelegramApiResponseError) return error.response; throw error; } }); bot.use((ctx, next) => { logger.debug(`[DEBUG] Incoming update: hasCallbackQuery=${!!ctx.callbackQuery}, hasMessage=${!!ctx.message}, callbackData=${ctx.callbackQuery?.data || "N/A"}`); return next(); }); bot.use(authMiddleware); bot.use(async (ctx, next) => { try { await resolveInboundTelegramTopic(ctx, bot); } catch (error) { logger.error("[TelegramTopics] Failed to resolve inbound Topic context:", error); } await next(); }); bot.use(staleUpdateMiddleware); bot.use(inboundRateLimitMiddleware); bot.use(ensureCommandsInitialized); bot.use(interactionGuardMiddleware); registerCommandRouter(bot, { ensureEventSubscription, clearRuntimeState: (reason) => eventSubscriptionService.clearRuntimeState(reason) }); registerCallbackRouter(bot, { ensureEventSubscription, setTelegramContext }); registerCanonicalModelKeyboard(bot); registerMessageRouter(bot, { ensureEventSubscription, setTelegramContext }); registerTelegramTopicDeleteHandlers(bot); safeBackgroundTask({ taskName: "bot.refreshGlobalCommands", task: async () => { try { await Promise.all([bot.api.setMyCommands(BOT_COMMANDS, { scope: { type: "default" } }), bot.api.setMyCommands(BOT_COMMANDS, { scope: { type: "all_private_chats" } })]); return { success: true as const }; } catch (error) { return { success: false as const, error }; } }, onSuccess: (result) => { if (result.success) { logger.debug("[Bot] Refreshed global Telegram command catalog"); return; } logger.warn("[Bot] Could not refresh global commands:", result.error); } }); bot.catch((err) => { logger.error("[Bot] Unhandled error in bot:", err); clearAllInteractionState("bot_unhandled_error"); if (err.ctx) logger.error("[Bot] Error context - update type:", err.ctx.update ? Object.keys(err.ctx.update) : "unknown"); }); return bot; }
export function cleanupBotRuntime(reason: string): void { unsubscribeReadyRestore?.(); unsubscribeReadyRestore = null; eventSubscriptionService.cleanup(reason); if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } setActiveTelegramTopic(null); }

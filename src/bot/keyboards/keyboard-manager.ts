import type { Api } from "grammy";
import { createMainInlineKeyboard, createMainKeyboard, createTopicKeyboard } from "./main-reply-keyboard.js";
import { getQueuedPromptButtonLabels } from "./queued-prompt-button.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { getCompactOutputMode, getMainNavigationMessageId, setMainNavigationMessageId, clearMainNavigationMessageId } from "../../app/stores/settings-store.js";
import type { ModelInfo } from "../../app/types/model.js";
import type { ContextInfo, KeyboardState } from "./keyboard-types.js";
import { t } from "../../i18n/index.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { BOT_VERSION, getOpenCodeVersion } from "../../app/services/version-info-service.js";
import { formatModelForDisplay } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";

const MAIN_KEY = "__main__";

function normalizeOutboundThreadId(threadId?: number): number | undefined {
  return typeof threadId === "number" && threadId > 1 ? threadId : undefined;
}

export async function buildMainStatusText(currentModel: ModelInfo = getStoredModel()): Promise<string> {
  const currentAgent = getStoredAgent();
  const modelDisplay = currentModel.providerID && currentModel.modelID
    ? formatModelForDisplay(currentModel.providerID, currentModel.modelID, currentModel.name)
    : "Not configured";
  const openCodeVersion = await getOpenCodeVersion();

  return [
    "⚡ <b>OpenCode Telegram</b>", "", "🟢 <b>Ready</b>",
    `🤖 Bot <b>v${BOT_VERSION}</b>`, `🧠 OpenCode <b>v${openCodeVersion}</b>`,
    `🤖 ${modelDisplay}`, `🛠️ ${currentAgent}`, "",
    "Build, debug and control OpenCode directly from Telegram.", "",
    "💬 Use New Chat to start a fresh coding Topic, or open an existing Topic to continue its session.",
  ].join("\n");
}

class KeyboardManager {
  private readonly states = new Map<string, KeyboardState>();
  private api: Api | null = null;
  private readonly lastUpdateTimes = new Map<string, number>();
  private readonly mainInlineMessageIds = new Map<number, number>();
  private readonly mainPinnedMessageIds = new Map<number, number>();
  private readonly mainAnchorLocks = new Map<number, Promise<void>>();
  private readonly topicModeChats = new Set<number>();
  private readonly UPDATE_DEBOUNCE_MS = 2000;

  private key(sessionId?: string): string { return sessionId ?? MAIN_KEY; }
  private resolveSessionId(sessionId?: string): string | undefined { return sessionId ?? getTopicRuntimeContext()?.sessionId; }

  private async withMainAnchorLock<T>(chatId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.mainAnchorLocks.get(chatId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.mainAnchorLocks.set(chatId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mainAnchorLocks.get(chatId) === queued) this.mainAnchorLocks.delete(chatId);
    }
  }

  public initialize(api: Api, chatId: number, sessionId?: string, threadId?: number): void {
    this.api = api;
    const key = this.key(sessionId);
    const existing = this.states.get(key);
    if (!existing) {
      const currentModel = getStoredModel();
      this.states.set(key, {
        sessionId,
        chatId,
        threadId: normalizeOutboundThreadId(threadId),
        currentAgent: getStoredAgent(),
        currentModel,
        contextInfo: null,
        variantName: formatVariantForButton(currentModel.variant || "default"),
        paused: sessionId ? isChatPaused(sessionId) : isChatPaused(),
      });
      return;
    }
    existing.chatId = chatId;
    if (threadId !== undefined) existing.threadId = normalizeOutboundThreadId(threadId);
  }

  public bindTopic(api: Api, chatId: number, threadId: number, sessionId: string): void {
    this.topicModeChats.add(chatId);
    this.initialize(api, chatId, sessionId, threadId);
  }

  public async setMainInlineMessage(chatId: number, messageId: number): Promise<void> {
    await this.withMainAnchorLock(chatId, async () => {
      if (!this.api || !messageId) return;

      const previousMessageId = this.getPersistedMainInlineMessageId(chatId);
      if (previousMessageId === messageId) {
        await this.ensureMainAnchorPinnedLocked(chatId, messageId, true);
        return;
      }

      const pinned = await this.ensureMainAnchorPinnedLocked(chatId, messageId, true);
      if (!pinned) {
        logger.warn(`[TelegramKeyboard] Main anchor replacement aborted because the new message could not be pinned: chat=${chatId}, message=${messageId}`);
        return;
      }

      this.mainInlineMessageIds.set(chatId, messageId);
      try {
        await setMainNavigationMessageId(chatId, messageId);
      } catch (error) {
        logger.error(`[TelegramKeyboard] Failed to persist new Main anchor; keeping Telegram state safe: chat=${chatId}, message=${messageId}`, error);
        await this.clearMainAnchor(chatId, messageId);
        this.mainInlineMessageIds.delete(chatId);
        return;
      }

      if (previousMessageId && previousMessageId !== messageId) await this.clearMainAnchor(chatId, previousMessageId);
      logger.info(`[TelegramKeyboard] Main anchor committed after successful pin: chat=${chatId}, message=${messageId}`);
    });
  }

  private getPersistedMainInlineMessageId(chatId: number): number | undefined {
    const inMemory = this.mainInlineMessageIds.get(chatId);
    if (inMemory) return inMemory;
    const persisted = getMainNavigationMessageId(chatId);
    if (persisted) this.mainInlineMessageIds.set(chatId, persisted);
    return persisted;
  }

  private async clearMainAnchor(chatId: number, messageId: number): Promise<void> {
    if (!this.api) return;
    try { await this.api.unpinChatMessage(chatId, messageId); logger.info(`[TelegramKeyboard] Previous Main anchor unpinned: chat=${chatId}, message=${messageId}`); }
    catch (err) { logger.debug(`[TelegramKeyboard] Previous Main anchor was not unpinned (may already be unpinned): chat=${chatId}, message=${messageId}`, err); }
    if (this.mainPinnedMessageIds.get(chatId) === messageId) this.mainPinnedMessageIds.delete(chatId);
  }

  private async ensureMainAnchorPinnedLocked(chatId: number, messageId: number, forceVerify = false): Promise<boolean> {
    if (!this.api || !messageId) return false;
    if (!forceVerify && this.mainPinnedMessageIds.get(chatId) === messageId) return true;
    try {
      const chat = await this.api.getChat(chatId);
      const pinnedMessage = "pinned_message" in chat ? chat.pinned_message : undefined;
      const latestPinnedMessageId = pinnedMessage && "message_id" in pinnedMessage ? pinnedMessage.message_id : undefined;
      if (latestPinnedMessageId === messageId) { this.mainPinnedMessageIds.set(chatId, messageId); logger.debug(`[TelegramKeyboard] Main anchor already pinned; no pin mutation needed: chat=${chatId}, message=${messageId}`); return true; }
    } catch (error) { logger.debug(`[TelegramKeyboard] Could not inspect current pin state; attempting direct pin: chat=${chatId}, message=${messageId}`, error); }
    try { await this.api.pinChatMessage(chatId, messageId, { disable_notification: true }); this.mainPinnedMessageIds.set(chatId, messageId); logger.info(`[TelegramKeyboard] Main status + InlineKeyboard pinned: chat=${chatId}, message=${messageId}`); return true; }
    catch (error) { logger.warn(`[TelegramKeyboard] Failed to pin Main status + InlineKeyboard: chat=${chatId}, message=${messageId}`, error); return false; }
  }

  public async pinMainInlineMessage(chatId: number, messageId?: number): Promise<void> {
    await this.withMainAnchorLock(chatId, async () => { const targetMessageId = messageId ?? this.getPersistedMainInlineMessageId(chatId); if (!targetMessageId) return; await this.ensureMainAnchorPinnedLocked(chatId, targetMessageId, true); });
  }

  public isTopicMode(chatId: number): boolean { return this.topicModeChats.has(chatId); }
  public async enterTopicMode(chatId: number): Promise<void> { this.topicModeChats.add(chatId); logger.info(`[TopicMode] Entered Topic Mode without replacing General InlineKeyboard: chat=${chatId}`); }
  public async activateTopicMode(chatId: number, currentModel: ModelInfo = getStoredModel()): Promise<void> { await this.enterTopicMode(chatId); await this.sendTopicMainKeyboard(chatId, currentModel, true); }
  public async hideMainInlineKeyboard(chatId: number): Promise<void> { logger.debug(`[TopicMode] Ignoring request to hide General InlineKeyboard: chat=${chatId}`); }
  public async clearMainInlineKeyboard(chatId: number): Promise<void> { logger.debug(`[TelegramKeyboard] Keeping persistent Main status + InlineKeyboard message: chat=${chatId}`); }
  public async clearMainInlineMessage(chatId: number): Promise<void> { logger.debug(`[TelegramKeyboard] Keeping persistent Main status + InlineKeyboard message: chat=${chatId}`); }
  public async sendTopicMainKeyboard(chatId: number, currentModel: ModelInfo = getStoredModel(), force = false): Promise<void> { await this.sendMainInlineKeyboard(chatId, currentModel, force); }

  public async sendMainInlineKeyboard(chatId: number, currentModel: ModelInfo = getStoredModel(), force = false): Promise<void> {
    await this.withMainAnchorLock(chatId, async () => {
      if (!this.api) return;
      const now = Date.now();
      const updateKey = `${MAIN_KEY}:${chatId}`;
      const previous = this.lastUpdateTimes.get(updateKey) ?? 0;
      if (!force && now - previous < this.UPDATE_DEBOUNCE_MS) return;
      this.lastUpdateTimes.set(updateKey, now);
      const text = await buildMainStatusText(currentModel);
      const replyMarkup = createMainInlineKeyboard(currentModel);
      const existingMessageId = this.getPersistedMainInlineMessageId(chatId);
      if (existingMessageId) {
        try {
          await this.api.editMessageText(chatId, existingMessageId, text, { parse_mode: "HTML", reply_markup: replyMarkup });
          const pinned = await this.ensureMainAnchorPinnedLocked(chatId, existingMessageId, force);
          if (pinned) { logger.info(`[TelegramKeyboard] Restored persistent Main status + InlineKeyboard in-place: chat=${chatId}, message=${existingMessageId}`); return; }
          logger.warn(`[TelegramKeyboard] Main anchor edited successfully but pin could not be ensured; retaining canonical message: chat=${chatId}, message=${existingMessageId}`);
          return;
        } catch (err) { logger.debug(`[TelegramKeyboard] Existing Main status message unavailable; creating replacement: chat=${chatId}, message=${existingMessageId}`, err); }
        await this.clearMainAnchor(chatId, existingMessageId);
        this.mainInlineMessageIds.delete(chatId);
        await clearMainNavigationMessageId(chatId);
      }
      try {
        const response = await this.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: replyMarkup });
        const pinned = await this.ensureMainAnchorPinnedLocked(chatId, response.message_id, true);
        if (!pinned) {
          logger.warn(`[TelegramKeyboard] New Main anchor was sent but could not be pinned; canonical state was not changed: chat=${chatId}, message=${response.message_id}`);
          try { await this.api.deleteMessage(chatId, response.message_id); } catch (cleanupError) { logger.debug(`[TelegramKeyboard] Failed to remove unpinned Main anchor candidate: chat=${chatId}, message=${response.message_id}`, cleanupError); }
          return;
        }
        this.mainInlineMessageIds.set(chatId, response.message_id);
        await setMainNavigationMessageId(chatId, response.message_id);
        logger.info(`[TelegramKeyboard] Main status + InlineKeyboard anchored and pinned: chat=${chatId}, message=${response.message_id}`);
      } catch (err) { logger.error("[TelegramKeyboard] Failed to send anchored Main InlineKeyboard:", err); }
    });
  }

  private state(sessionId?: string): KeyboardState | undefined { return this.states.get(this.key(this.resolveSessionId(sessionId))); }
  public updateAgent(agent: string, sessionId?: string): void { const state = this.state(sessionId); if (state) state.currentAgent = agent; }
  public updateModel(model: ModelInfo, sessionId?: string): void { const state = this.state(sessionId); if (!state) return; state.currentModel = model; state.variantName = formatVariantForButton(model.variant || "default"); }
  public updateVariant(variantId: string, sessionId?: string): void { const state = this.state(sessionId); if (state) state.variantName = formatVariantForButton(variantId); }
  public setPaused(paused: boolean, sessionId?: string): void { const state = this.state(sessionId); if (state) state.paused = paused; }
  public updateContext(tokensUsed: number, tokensLimit: number, sessionId?: string): void { const state = this.state(sessionId); if (state) state.contextInfo = { tokensUsed, tokensLimit }; }
  public clearContext(sessionId?: string): void { const state = this.state(sessionId); if (state) state.contextInfo = null; }
  public getContextInfo(sessionId?: string): ContextInfo | null { return this.state(sessionId)?.contextInfo ?? null; }

  private buildKeyboard(sessionId?: string) {
    const state = this.state(sessionId);
    if (state?.sessionId && state.threadId !== undefined) {
      const paused = isChatPaused(state.sessionId);
      const running = assistantRunState.hasActiveRun(state.sessionId);
      return createTopicKeyboard({
        paused,
        running,
        compactOutputMode: getCompactOutputMode(),
        currentModel: state.currentModel ?? getStoredModel(),
      });
    }
    if (!state) return createMainKeyboard({ providerID: "", modelID: "" }, { paused: false, running: false, compactOutputMode: getCompactOutputMode(), isTopic: false });
    return createMainKeyboard(state.currentModel, { queuedPromptLabels: getQueuedPromptButtonLabels(), paused: false, running: false, compactOutputMode: getCompactOutputMode(), isTopic: false });
  }

  public async sendKeyboardUpdate(chatId?: number, force = false, sessionId?: string): Promise<void> {
    if (!this.api) return;
    const resolvedSessionId = this.resolveSessionId(sessionId);
    const state = this.state(resolvedSessionId);
    const targetChatId = chatId ?? state?.chatId;
    if (!targetChatId) return;
    const key = this.key(resolvedSessionId);
    const now = Date.now();
    const previous = this.lastUpdateTimes.get(key) ?? 0;
    if (!force && now - previous < this.UPDATE_DEBOUNCE_MS) return;
    this.lastUpdateTimes.set(key, now);
    try {
      const isTopic = Boolean(state?.sessionId && state.threadId !== undefined);
      if (!isTopic) { await this.sendMainInlineKeyboard(targetChatId, state?.currentModel ?? getStoredModel(), true); return; }
      const keyboard = this.buildKeyboard(resolvedSessionId);
      const options: Record<string, unknown> = { reply_markup: keyboard };
      const threadId = normalizeOutboundThreadId(state?.threadId);
      if (threadId !== undefined) options.message_thread_id = threadId;
      await this.api.sendMessage(targetChatId, t("keyboard.updated"), options as never);
      logger.info(`[KeyboardManager] Sent AI Topic ReplyKeyboard: chat=${targetChatId}, thread=${threadId ?? "General(native-default)"}, model=${state?.currentModel?.modelID ?? "unset"}, compact=${getCompactOutputMode()}`);
    } catch (err) { logger.error("[KeyboardManager] Failed to send keyboard update:", err); }
  }

  public getKeyboard(sessionId?: string) {
    const resolved = this.resolveSessionId(sessionId);
    if (this.state(resolved)) return this.buildKeyboard(resolved);
    if (!resolved && this.api) return createMainKeyboard({ providerID: "", modelID: "" }, { paused: false, running: false, compactOutputMode: getCompactOutputMode(), isTopic: false });
    return undefined;
  }

  public getState(sessionId?: string): KeyboardState | undefined { return this.state(sessionId); }
  public isInitialized(sessionId?: string): boolean { return Boolean(this.state(sessionId)) || (!sessionId && Boolean(this.api)); }
  public getThreadIdForSession(sessionId?: string): number | undefined { return this.state(sessionId)?.threadId; }
  public clearSession(sessionId: string): void { this.states.delete(this.key(sessionId)); this.lastUpdateTimes.delete(this.key(sessionId)); }
}

export const keyboardManager = new KeyboardManager();
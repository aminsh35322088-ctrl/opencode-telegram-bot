import type { Api } from "grammy";
import { createMainInlineKeyboard, createMainKeyboard, createTopicKeyboard } from "./main-reply-keyboard.js";
import { getQueuedPromptButtonLabels } from "./queued-prompt-button.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { getCompactOutputMode } from "../../app/stores/settings-store.js";
import type { ModelInfo } from "../../app/types/model.js";
import type { ContextInfo, KeyboardState } from "./keyboard-types.js";
import { t } from "../../i18n/index.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { logger } from "../../utils/logger.js";

const MAIN_KEY = "__main__";

function normalizeOutboundThreadId(threadId?: number): number | undefined {
  return typeof threadId === "number" && threadId > 1 ? threadId : undefined;
}

class KeyboardManager {
  private readonly states = new Map<string, KeyboardState>();
  private api: Api | null = null;
  private readonly lastUpdateTimes = new Map<string, number>();
  private readonly mainInlineMessageIds = new Map<number, number>();
  private readonly topicModeChats = new Set<number>();
  private readonly UPDATE_DEBOUNCE_MS = 2000;

  private key(sessionId?: string): string { return sessionId ?? MAIN_KEY; }
  private resolveSessionId(sessionId?: string): string | undefined { return sessionId ?? getTopicRuntimeContext()?.sessionId; }

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

  public setMainInlineMessage(chatId: number, messageId: number): void {
    this.mainInlineMessageIds.set(chatId, messageId);
  }

  public isTopicMode(chatId: number): boolean {
    return this.topicModeChats.has(chatId);
  }

  public async enterTopicMode(chatId: number): Promise<void> {
    // Topic Mode no longer replaces General/All's inline navigation. The AI Topic
    // may have its own ReplyKeyboard, but General keeps the glass navigation.
    this.topicModeChats.add(chatId);
    logger.info(`[TopicMode] Entered Topic Mode without replacing General InlineKeyboard: chat=${chatId}`);
  }

  public async activateTopicMode(chatId: number, currentModel: ModelInfo = getStoredModel()): Promise<void> {
    await this.enterTopicMode(chatId);
    await this.sendTopicMainKeyboard(chatId, currentModel, true);
  }

  public async hideMainInlineKeyboard(chatId: number): Promise<void> {
    // Kept as a compatibility method for callers. General/All navigation is now
    // intentionally persistent and must not be hidden when an AI Topic is created.
    logger.debug(`[TopicMode] Ignoring request to hide General InlineKeyboard: chat=${chatId}`);
  }

  public async clearMainInlineMessage(chatId: number): Promise<void> {
    if (!this.api) return;
    const messageId = this.mainInlineMessageIds.get(chatId);
    if (!messageId) return;
    try {
      await this.api.deleteMessage(chatId, messageId);
      logger.info(`[TelegramKeyboard] Removed previous Main InlineKeyboard message: chat=${chatId}, message=${messageId}`);
    } catch (err) {
      logger.debug(`[TelegramKeyboard] Previous Main InlineKeyboard message was already unavailable: chat=${chatId}, message=${messageId}`, err);
    }
    this.mainInlineMessageIds.delete(chatId);
  }

  public async sendTopicMainKeyboard(chatId: number, currentModel: ModelInfo = getStoredModel(), force = false): Promise<void> {
    // General/All always uses the glass keyboard. ReplyKeyboard is reserved for AI Topics.
    await this.sendMainInlineKeyboard(chatId, currentModel, force);
  }

  public async sendMainInlineKeyboard(chatId: number, currentModel: ModelInfo = getStoredModel(), force = false): Promise<void> {
    if (!this.api) return;
    const now = Date.now();
    const previous = this.lastUpdateTimes.get(MAIN_KEY) ?? 0;
    if (!force && now - previous < this.UPDATE_DEBOUNCE_MS) return;
    this.lastUpdateTimes.set(MAIN_KEY, now);

    await this.clearMainInlineMessage(chatId);
    try {
      const response = await this.api.sendMessage(chatId, t("keyboard.updated"), {
        reply_markup: createMainInlineKeyboard(currentModel),
      });
      this.mainInlineMessageIds.set(chatId, response.message_id);
      logger.info(`[TelegramKeyboard] Main InlineKeyboard anchored at bottom: chat=${chatId}, message=${response.message_id}`);
    } catch (err) {
      logger.error("[TelegramKeyboard] Failed to send anchored Main InlineKeyboard:", err);
    }
  }

  private state(sessionId?: string): KeyboardState | undefined {
    return this.states.get(this.key(this.resolveSessionId(sessionId)));
  }
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
      return createTopicKeyboard({ paused, running, compactOutputMode: getCompactOutputMode() });
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
      if (!isTopic) {
        await this.sendMainInlineKeyboard(targetChatId, state?.currentModel ?? getStoredModel(), true);
        return;
      }

      const keyboard = this.buildKeyboard(resolvedSessionId);
      const options: Record<string, unknown> = { reply_markup: keyboard };
      const threadId = normalizeOutboundThreadId(state?.threadId);
      if (threadId !== undefined) options.message_thread_id = threadId;
      await this.api.sendMessage(targetChatId, t("keyboard.updated"), options as never);
      logger.info(`[KeyboardManager] Sent AI Topic ReplyKeyboard: chat=${targetChatId}, thread=${threadId ?? "General(native-default)"}`);
    } catch (err) { logger.error("[KeyboardManager] Failed to send keyboard update:", err); }
  }

  public getKeyboard(sessionId?: string) {
    const resolved = this.resolveSessionId(sessionId);
    if (this.state(resolved)) return this.buildKeyboard(resolved);
    if (!resolved && this.api) {
      return createMainKeyboard({ providerID: "", modelID: "" }, { paused: false, running: false, compactOutputMode: getCompactOutputMode(), isTopic: false });
    }
    return undefined;
  }

  public getState(sessionId?: string): KeyboardState | undefined { return this.state(sessionId); }
  public isInitialized(sessionId?: string): boolean { return Boolean(this.state(sessionId)) || (!sessionId && Boolean(this.api)); }
  public getThreadIdForSession(sessionId?: string): number | undefined { return this.state(sessionId)?.threadId; }
  public clearSession(sessionId: string): void { this.states.delete(this.key(sessionId)); this.lastUpdateTimes.delete(this.key(sessionId)); }
}

export const keyboardManager = new KeyboardManager();
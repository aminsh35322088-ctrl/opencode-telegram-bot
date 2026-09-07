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

  public async setMainInlineMessage(chatId: number, messageId: number): Promise<void> {
    const previousMessageId = this.getPersistedMainInlineMessageId(chatId);
    if (previousMessageId && previousMessageId !== messageId) await this.clearMainAnchor(chatId, previousMessageId);
    this.mainInlineMessageIds.set(chatId, messageId);
    await setMainNavigationMessageId(chatId, messageId);
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
    try {
      await this.api.unpinChatMessage(chatId, messageId);
      logger.info(`[TelegramKeyboard] Previous Main anchor unpinned: chat=${chatId}, message=${messageId}`);
    } catch (err) {
      logger.debug(`[TelegramKeyboard] Previous Main anchor was not unpinned (may already be unpinned): chat=${chatId}, message=${messageId}`, err);
    }
  }

  /**
   * `/start` establishes the Main navigation message as the sole pinned anchor.
   * Telegram permits multiple pinned messages and pinChatMessage does not replace
   * existing pins, so the legacy/previous Main pins must be cleared explicitly.
   */
  public async clearAllMainNavigationPins(chatId: number): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.unpinAllChatMessages(chatId);
      logger.info(`[TelegramKeyboard] Cleared all existing pinned messages before Main /start anchor: chat=${chatId}`);
    } catch (err) {
      logger.warn(`[TelegramKeyboard] Failed to clear existing pinned messages before Main /start anchor: chat=${chatId}`, err);
    }
  }

  public async pinMainInlineMessage(chatId: number, messageId?: number): Promise<void> {
    if (!this.api) return;
    const targetMessageId = messageId ?? this.getPersistedMainInlineMessageId(chatId);
    if (!targetMessageId) return;
    try {
      await this.api.pinChatMessage(chatId, targetMessageId, { disable_notification: true });
      logger.info(`[TelegramKeyboard] Main status + InlineKeyboard pinned: chat=${chatId}, message=${targetMessageId}`);
    } catch (err) {
      logger.warn(`[TelegramKeyboard] Failed to pin Main status + InlineKeyboard: chat=${chatId}, message=${targetMessageId}`, err);
    }
  }

  public isTopicMode(chatId: number): boolean {
    return this.topicModeChats.has(chatId);
  }

  public async enterTopicMode(chatId: number): Promise<void> {
    this.topicModeChats.add(chatId);
    logger.info(`[TopicMode] Entered Topic Mode without replacing General InlineKeyboard: chat=${chatId}`);
  }

  public async activateTopicMode(chatId: number, currentModel: ModelInfo = getStoredModel()): Promise<void> {
    await this.enterTopicMode(chatId);
    await this.sendTopicMainKeyboard(chatId, currentModel, true);
  }

  public async hideMainInlineKeyboard(chatId: number): Promise<void> {
    logger.debug(`[TopicMode] Ignoring request to hide General InlineKeyboard: chat=${chatId}`);
  }

  public async clearMainInlineMessage(chatId: number): Promise<void> {
    logger.debug(`[TelegramKeyboard] Keeping persistent Main status + InlineKeyboard message: chat=${chatId}`);
  }

  public async sendTopicMainKeyboard(chatId: number, currentModel: ModelInfo = getStoredModel(), force = false): Promise<void> {
    await this.sendMainInlineKeyboard(chatId, currentModel, force);
  }

  public async sendMainInlineKeyboard(chatId: number, currentModel: ModelInfo = getStoredModel(), force = false): Promise<void> {
    if (!this.api) return;
    const now = Date.now();
    const previous = this.lastUpdateTimes.get(MAIN_KEY) ?? 0;
    if (!force && now - previous < this.UPDATE_DEBOUNCE_MS) return;
    this.lastUpdateTimes.set(MAIN_KEY, now);

    const text = await buildMainStatusText(currentModel);
    const replyMarkup = createMainInlineKeyboard(currentModel);
    const existingMessageId = this.getPersistedMainInlineMessageId(chatId);

    if (existingMessageId) {
      try {
        await this.api.editMessageText(chatId, existingMessageId, text, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
        await this.pinMainInlineMessage(chatId, existingMessageId);
        logger.info(`[TelegramKeyboard] Restored persistent Main status + InlineKeyboard in-place: chat=${chatId}, message=${existingMessageId}`);
        return;
      } catch (err) {
        logger.debug(`[TelegramKeyboard] Existing Main status message unavailable; creating replacement: chat=${chatId}, message=${existingMessageId}`, err);
        await this.clearMainAnchor(chatId, existingMessageId);
        this.mainInlineMessageIds.delete(chatId);
        await clearMainNavigationMessageId(chatId);
      }
    }

    try {
      const response = await this.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      });
      await this.setMainInlineMessage(chatId, response.message_id);
      await this.pinMainInlineMessage(chatId, response.message_id);
      logger.info(`[TelegramKeyboard] Main status + InlineKeyboard anchored and pinned: chat=${chatId}, message=${response.message_id}`);
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
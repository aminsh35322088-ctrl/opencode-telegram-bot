import type { Api } from "grammy";
import { createMainInlineKeyboard, createMainKeyboard, createTopicKeyboard } from "./main-reply-keyboard.js";
import { getQueuedPromptButtonLabels } from "./queued-prompt-button.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { getCompactOutputMode, getMainNavigationMessageId, setMainNavigationMessageId, clearMainNavigationMessageId } from "../../app/stores/settings-store.js";
import { getTopicRuntimeStateSync } from "../../app/stores/topic-runtime-state-store.js";
import type { ModelInfo } from "../../app/types/model.js";
import type { ContextInfo, KeyboardState } from "./keyboard-types.js";
import { t } from "../../i18n/index.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { BOT_VERSION, getOpenCodeVersion } from "../../app/services/version-info-service.js";
import { formatModelForDisplay } from "../../app/types/model.js";
import { getUnscopedTelegramApi } from "../services/telegram-topic-runtime.js";
import { logger } from "../../utils/logger.js";

const MAIN_KEY = "__main__";

function normalizeOutboundThreadId(threadId?: number): number | undefined {
  return typeof threadId === "number" && threadId > 1 ? threadId : undefined;
}

function isMessageNotModified(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message is not modified/i.test(message);
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
  private readonly mainAnchorLocks = new Map<number, Promise<void>>();
  private readonly topicModeChats = new Set<number>();
  private readonly UPDATE_DEBOUNCE_MS = 2000;

  private key(sessionId?: string): string { return sessionId ?? MAIN_KEY; }
  private resolveSessionId(sessionId?: string): string | undefined { return sessionId ?? getTopicRuntimeContext()?.sessionId; }

  private topicSelection(chatId: number, threadId?: number): { model?: ModelInfo; agent?: string } {
    const normalized = normalizeOutboundThreadId(threadId);
    if (normalized === undefined) return {};
    try {
      const state = getTopicRuntimeStateSync(chatId, normalized);
      return { model: state?.settings.model ?? undefined, agent: state?.settings.agent ?? undefined };
    } catch (error) {
      logger.debug(`[KeyboardManager] Could not resolve topic-scoped selection for chat=${chatId}, thread=${normalized}`, error);
      return {};
    }
  }

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
    // A Topic-scoped wrapper may arrive from attach/session restoration. The
    // keyboard manager owns both global Main UI and explicitly-threaded Topic
    // keyboards, so keeping that wrapper here would make a later Main send leak
    // into whichever Topic supplied the API. Always retain the raw/global API.
    this.api = getUnscopedTelegramApi(api);
    const key = this.key(sessionId);
    const existing = this.states.get(key);
    const topicSelection = this.topicSelection(chatId, threadId);
    if (!existing) {
      const currentModel = topicSelection.model ?? getStoredModel();
      this.states.set(key, {
        sessionId,
        chatId,
        threadId: normalizeOutboundThreadId(threadId),
        currentAgent: topicSelection.agent ?? getStoredAgent(),
        currentModel,
        contextInfo: null,
        variantName: formatVariantForButton(currentModel.variant || "default"),
        paused: sessionId ? isChatPaused(sessionId) : isChatPaused(),
      });
      return;
    }
    existing.chatId = chatId;
    if (threadId !== undefined) existing.threadId = normalizeOutboundThreadId(threadId);
    if (topicSelection.model) {
      existing.currentModel = topicSelection.model;
      existing.variantName = formatVariantForButton(topicSelection.model.variant || "default");
    }
    if (topicSelection.agent) existing.currentAgent = topicSelection.agent;
  }

  public bindTopic(api: Api, chatId: number, threadId: number, sessionId: string): void {
    this.topicModeChats.add(chatId);
    this.initialize(api, chatId, sessionId, threadId);
  }

  /**
   * The canonical Main navigation lives outside real Topic threads (the All/root
   * view). Only that root message may be pinned. Topic keyboards never call this
   * path, and a response carrying a real message_thread_id is rejected below.
   */
  public async setMainInlineMessage(chatId: number, messageId: number): Promise<void> {
    await this.withMainAnchorLock(chatId, async () => {
      if (!this.api || !messageId) return;

      const previousMessageId = this.getPersistedMainInlineMessageId(chatId);
      this.mainInlineMessageIds.set(chatId, messageId);
      try {
        await setMainNavigationMessageId(chatId, messageId);
      } catch (error) {
        logger.error(`[TelegramKeyboard] Failed to persist Main navigation message: chat=${chatId}, message=${messageId}`, error);
        this.mainInlineMessageIds.delete(chatId);
        return;
      }

      if (previousMessageId && previousMessageId !== messageId) await this.retireMainAnchor(chatId, previousMessageId);
      await this.pinMainAnchor(chatId, messageId);
      logger.info(`[TelegramKeyboard] Main navigation message committed and pinned in All/root: chat=${chatId}, message=${messageId}`);
    });
  }

  private getPersistedMainInlineMessageId(chatId: number): number | undefined {
    const inMemory = this.mainInlineMessageIds.get(chatId);
    if (inMemory) return inMemory;
    const persisted = getMainNavigationMessageId(chatId);
    if (persisted) this.mainInlineMessageIds.set(chatId, persisted);
    return persisted;
  }

  private async pinMainAnchor(chatId: number, messageId: number): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.pinChatMessage(chatId, messageId, { disable_notification: true });
      logger.info(`[TelegramKeyboard] Main navigation pinned in All/root: chat=${chatId}, message=${messageId}`);
    } catch (error) {
      logger.error(`[TelegramKeyboard] Failed to pin Main navigation in All/root: chat=${chatId}, message=${messageId}`, error);
    }
  }

  private async unpinMainAnchor(chatId: number, messageId: number): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.unpinChatMessage(chatId, messageId);
      logger.info(`[TelegramKeyboard] Previous Main navigation message unpinned: chat=${chatId}, message=${messageId}`);
    } catch (error) {
      logger.debug(`[TelegramKeyboard] Main navigation message was not pinned or could not be unpinned: chat=${chatId}, message=${messageId}`, error);
    }
  }

  private async retireMainAnchor(chatId: number, messageId: number): Promise<void> {
    if (!this.api) return;
    await this.unpinMainAnchor(chatId, messageId);
    try {
      await this.api.deleteMessage(chatId, messageId);
      logger.info(`[TelegramKeyboard] Retired previous Main navigation message: chat=${chatId}, message=${messageId}`);
    } catch (error) {
      logger.debug(`[TelegramKeyboard] Previous Main navigation message could not be deleted: chat=${chatId}, message=${messageId}`, error);
    }
  }

  /** Backwards-compatible entrypoint for callers that explicitly refresh the Main pin. */
  public async pinMainInlineMessage(chatId: number, messageId?: number): Promise<void> {
    await this.withMainAnchorLock(chatId, async () => {
      const targetMessageId = messageId ?? this.getPersistedMainInlineMessageId(chatId);
      if (!targetMessageId) return;
      await this.pinMainAnchor(chatId, targetMessageId);
    });
  }

  public isTopicMode(chatId: number): boolean { return this.topicModeChats.has(chatId); }
  public async enterTopicMode(chatId: number): Promise<void> { this.topicModeChats.add(chatId); logger.info(`[TopicMode] Entered Topic Mode without replacing General InlineKeyboard: chat=${chatId}`); }
  public async activateTopicMode(chatId: number, currentModel: ModelInfo = getStoredModel()): Promise<void> { await this.enterTopicMode(chatId); await this.sendTopicMainKeyboard(chatId, currentModel, true); }
  public async hideMainInlineKeyboard(chatId: number): Promise<void> { logger.debug(`[TopicMode] Ignoring request to hide General InlineKeyboard: chat=${chatId}`); }
  public async clearMainInlineKeyboard(chatId: number): Promise<void> { logger.debug(`[TelegramKeyboard] Keeping persistent pinned Main status + InlineKeyboard message in All/root: chat=${chatId}`); }
  public async clearMainInlineMessage(chatId: number): Promise<void> { logger.debug(`[TelegramKeyboard] Keeping persistent pinned Main status + InlineKeyboard message in All/root: chat=${chatId}`); }
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
          await this.pinMainAnchor(chatId, existingMessageId);
          logger.info(`[TelegramKeyboard] Restored pinned Main status + InlineKeyboard in-place: chat=${chatId}, message=${existingMessageId}`);
          return;
        } catch (err) {
          // Telegram returns 400 when both the text and markup are already
          // identical. That is success for an idempotent refresh; still ensure
          // the canonical root message is pinned.
          if (isMessageNotModified(err)) {
            await this.pinMainAnchor(chatId, existingMessageId);
            logger.info(`[TelegramKeyboard] Main navigation already current and pinned: chat=${chatId}, message=${existingMessageId}`);
            return;
          }
          logger.debug(`[TelegramKeyboard] Existing Main status message unavailable; creating replacement: chat=${chatId}, message=${existingMessageId}`, err);
        }
        this.mainInlineMessageIds.delete(chatId);
        await clearMainNavigationMessageId(chatId);
        await this.retireMainAnchor(chatId, existingMessageId);
      }
      try {
        const response = await this.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: replyMarkup });
        // Main/root navigation must never carry a real Topic id. Fail closed if
        // a future wrapper regression ever tries to scope it again.
        if (typeof response.message_thread_id === "number" && response.message_thread_id > 1) {
          await this.api.deleteMessage(chatId, response.message_id).catch(() => {});
          logger.error(`[TelegramKeyboard] Refused Topic-scoped Main navigation message: chat=${chatId}, message=${response.message_id}, thread=${response.message_thread_id}`);
          return;
        }
        this.mainInlineMessageIds.set(chatId, response.message_id);
        try {
          await setMainNavigationMessageId(chatId, response.message_id);
        } catch (persistError) {
          this.mainInlineMessageIds.delete(chatId);
          await this.api.deleteMessage(chatId, response.message_id).catch(() => {});
          throw persistError;
        }
        await this.pinMainAnchor(chatId, response.message_id);
        logger.info(`[TelegramKeyboard] Main status + InlineKeyboard stored and pinned outside Topics: chat=${chatId}, message=${response.message_id}, thread=${response.message_thread_id ?? "root"}`);
      } catch (err) { logger.error("[TelegramKeyboard] Failed to send Main InlineKeyboard:", err); }
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

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
  private readonly replyKeyboardFingerprints = new Map<string, string>();
  private readonly topicKeyboardUpdates = new Map<string, Promise<void>>();
  private readonly lastRunningState = new Map<string, boolean>();
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

  private async pinMainAnchor(chatId: number, messageId: number): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.pinChatMessage(chatId, messageId, { disable_notification: true });
      logger.info(`[TelegramKeyboard] Main navigation pinned in All/root: chat=${chatId}, message=${messageId}`);
      return true;
    } catch (error) {
      logger.error(`[TelegramKeyboard] Failed to pin Main navigation in All/root: chat=${chatId}, message=${messageId}`, error);
      return false;
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

  private async rollbackMainAnchorCandidate(chatId: number, messageId: number): Promise<void> {
    if (!this.api) return;
    await this.unpinMainAnchor(chatId, messageId);
    try {
      await this.api.deleteMessage(chatId, messageId);
    } catch (error) {
      logger.debug(`[TelegramKeyboard] Failed to remove rejected Main navigation candidate: chat=${chatId}, message=${messageId}`, error);
    }
  }

  private async restorePersistedMainAnchor(chatId: number, previousMessageId?: number): Promise<void> {
    try {
      if (previousMessageId) await setMainNavigationMessageId(chatId, previousMessageId);
      else await clearMainNavigationMessageId(chatId);
    } catch (error) {
      logger.error(`[TelegramKeyboard] Failed to restore previous Main navigation state after replacement rollback: chat=${chatId}, previous=${previousMessageId ?? "none"}`, error);
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

  /**
   * /start in All/root is a replacement operation, not a refresh. A fresh root
   * panel is created first and must be pinnable + persistable before the old
   * canonical anchor is unpinned/deleted. This prevents a failed /start from
   * destroying the last good Main panel, while still guaranteeing one canonical
   * bot-owned pin after a successful replacement.
   */
  public async replaceMainInlineKeyboard(chatId: number, currentModel: ModelInfo = getStoredModel()): Promise<boolean> {
    return this.withMainAnchorLock(chatId, async () => {
      if (!this.api) return false;

      const previousMessageId = this.getPersistedMainInlineMessageId(chatId);
      const text = await buildMainStatusText(currentModel);
      const replyMarkup = createMainInlineKeyboard(currentModel);
      let replacementMessageId: number | undefined;

      try {
        const response = await this.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: replyMarkup });
        replacementMessageId = response.message_id;

        // Main/root navigation must never carry a real Topic id. Reject and
        // remove any candidate that a scoped API regression routes into a Topic.
        if (typeof response.message_thread_id === "number" && response.message_thread_id > 1) {
          await this.api.deleteMessage(chatId, response.message_id).catch(() => {});
          logger.error(`[TelegramKeyboard] Refused Topic-scoped replacement Main navigation message: chat=${chatId}, message=${response.message_id}, thread=${response.message_thread_id}`);
          return false;
        }

        if (!(await this.pinMainAnchor(chatId, response.message_id))) {
          await this.rollbackMainAnchorCandidate(chatId, response.message_id);
          if (previousMessageId) await this.pinMainAnchor(chatId, previousMessageId);
          logger.error(`[TelegramKeyboard] /start replacement aborted because new Main navigation could not be pinned: chat=${chatId}, message=${response.message_id}`);
          return false;
        }

        try {
          await setMainNavigationMessageId(chatId, response.message_id);
        } catch (persistError) {
          await this.restorePersistedMainAnchor(chatId, previousMessageId);
          await this.rollbackMainAnchorCandidate(chatId, response.message_id);
          if (previousMessageId) await this.pinMainAnchor(chatId, previousMessageId);
          logger.error(`[TelegramKeyboard] /start replacement rolled back because new Main navigation could not be persisted: chat=${chatId}, message=${response.message_id}`, persistError);
          return false;
        }

        this.mainInlineMessageIds.set(chatId, response.message_id);
        this.lastUpdateTimes.set(`${MAIN_KEY}:${chatId}`, Date.now());

        if (previousMessageId && previousMessageId !== response.message_id) {
          await this.retireMainAnchor(chatId, previousMessageId);
        }

        logger.info(`[TelegramKeyboard] /start replaced Main navigation anchor in All/root: chat=${chatId}, previous=${previousMessageId ?? "none"}, current=${response.message_id}`);
        return true;
      } catch (error) {
        if (replacementMessageId) await this.rollbackMainAnchorCandidate(chatId, replacementMessageId);
        if (previousMessageId) await this.pinMainAnchor(chatId, previousMessageId);
        logger.error(`[TelegramKeyboard] Failed to replace Main navigation anchor from /start: chat=${chatId}`, error);
        return false;
      }
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

  private replyKeyboardFingerprint(sessionId?: string): string | null {
    const keyboard = this.buildKeyboard(sessionId);
    if (!keyboard) return null;
    return JSON.stringify({
      keyboard: keyboard.keyboard,
      resize_keyboard: keyboard.resize_keyboard,
      is_persistent: keyboard.is_persistent,
      one_time_keyboard: keyboard.one_time_keyboard,
    });
  }

  public markKeyboardDelivered(sessionId: string): void {
    const fingerprint = this.replyKeyboardFingerprint(sessionId);
    if (fingerprint) this.replyKeyboardFingerprints.set(this.key(sessionId), fingerprint);
  }

  /** Explicit user recovery must bypass layout deduplication, including during inference. */
  public async restoreTopicKeyboard(sessionId: string): Promise<void> {
    await this.queueTopicKeyboardUpdate(sessionId, async () => {
      const state = this.state(sessionId);
      if (!state?.sessionId || state.threadId === undefined) return;
      this.replyKeyboardFingerprints.delete(this.key(sessionId));
      await this.deliverKeyboardUpdate(state.chatId, true, sessionId);
    });
  }

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
    const resolved = this.resolveSessionId(sessionId);
    if (!resolved) return this.deliverKeyboardUpdate(chatId, force);
    await this.queueTopicKeyboardUpdate(resolved, () => this.deliverKeyboardUpdate(chatId, force, resolved));
  }

  private async queueTopicKeyboardUpdate(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.topicKeyboardUpdates.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.topicKeyboardUpdates.set(sessionId, current);
    try { await current; }
    finally {
      if (this.topicKeyboardUpdates.get(sessionId) === current) this.topicKeyboardUpdates.delete(sessionId);
    }
  }

  private async deliverKeyboardUpdate(chatId?: number, force = false, sessionId?: string): Promise<void> {
    if (!this.api) return;
    const resolvedSessionId = this.resolveSessionId(sessionId);
    const state = this.state(resolvedSessionId);
    // A queued refresh may outlive a deleted Topic; never turn it into Main UI.
    if (resolvedSessionId && !state) return;
    const targetChatId = chatId ?? state?.chatId;
    if (!targetChatId) return;
    const key = this.key(resolvedSessionId);
    const isTopic = Boolean(state?.sessionId && state.threadId !== undefined);

    // State transitions must arrive even within debounce (idle -> running ->
    // paused). Deduplicate identical layouts, never suppress running controls.
    const fingerprint = isTopic ? this.replyKeyboardFingerprint(resolvedSessionId) : null;
    if (fingerprint && this.replyKeyboardFingerprints.get(key) === fingerprint) return;

    // Force delivery on idle<->running state transitions so the user always
    // sees the correct controls (Pause/Abort during run, idle layout after).
    const currentRunning = Boolean(resolvedSessionId && assistantRunState.hasActiveRun(resolvedSessionId));
    const previousRunning = this.lastRunningState.get(key) ?? false;
    const stateChanged = isTopic && currentRunning !== previousRunning;
    if (stateChanged) this.lastRunningState.set(key, currentRunning);

    const now = Date.now();
    const previous = this.lastUpdateTimes.get(key) ?? 0;
    if (!isTopic && !force && !stateChanged && now - previous < this.UPDATE_DEBOUNCE_MS) return;
    this.lastUpdateTimes.set(key, now);
    try {
      if (!isTopic) { await this.sendMainInlineKeyboard(targetChatId, state?.currentModel ?? getStoredModel(), true); return; }
      const keyboard = this.buildKeyboard(resolvedSessionId);
      const options: Record<string, unknown> = { reply_markup: keyboard, disable_notification: true };
      const threadId = normalizeOutboundThreadId(state?.threadId);
      if (threadId !== undefined) options.message_thread_id = threadId;
      await this.api.sendMessage(targetChatId, "⌨️ Keyboard updated", options as never);
      if (fingerprint) this.replyKeyboardFingerprints.set(key, fingerprint);
      logger.info(`[KeyboardManager] Refreshed persistent AI Topic ReplyKeyboard: chat=${targetChatId}, thread=${threadId ?? "General(native-default)"}, model=${state?.currentModel?.modelID ?? "unset"}, compact=${getCompactOutputMode()}`);
    } catch (err) { logger.error("[KeyboardManager] Failed to send keyboard update:", err); }
  }

  public getKeyboard(sessionId?: string) {
    const resolved = this.resolveSessionId(sessionId);
    const state = this.state(resolved);
    if (state) {
      return this.buildKeyboard(resolved);
    }
    if (!resolved && this.api) return createMainKeyboard({ providerID: "", modelID: "" }, { paused: false, running: false, compactOutputMode: getCompactOutputMode(), isTopic: false });
    return undefined;
  }

  public getState(sessionId?: string): KeyboardState | undefined { return this.state(sessionId); }
  public isInitialized(sessionId?: string): boolean { return Boolean(this.state(sessionId)) || (!sessionId && Boolean(this.api)); }
  public getThreadIdForSession(sessionId?: string): number | undefined { return this.state(sessionId)?.threadId; }

  /**
   * Authoritative delivery target for a Topic session. Async session output
   * must be pinned to this thread so it cannot leak into All/General even when
   * the chat-global bot context was last clobbered by unbound inbound traffic.
   */
  public getTopicSendTarget(sessionId?: string): { chatId: number; threadId: number } | undefined {
    const state = this.state(sessionId);
    const chatId = state?.chatId;
    const threadId = state?.threadId;
    if (!state || chatId === undefined || threadId === undefined || threadId <= 1) return undefined;
    return { chatId, threadId };
  }

  public clearSession(sessionId: string): void {
    const key = this.key(sessionId);
    this.states.delete(key);
    this.lastUpdateTimes.delete(key);
    this.replyKeyboardFingerprints.delete(key);
    this.lastRunningState.delete(key);
  }
}

export const keyboardManager = new KeyboardManager();

import type { Api } from "grammy";
import { createMainKeyboard, createTopicKeyboard } from "./main-reply-keyboard.js";
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
import { getMainTelegramThreadIdSync } from "../../app/services/telegram-main-topic-store.js";
import { logger } from "../../utils/logger.js";

const MAIN_KEY = "__main__";

class KeyboardManager {
  private readonly states = new Map<string, KeyboardState>();
  private api: Api | null = null;
  private readonly lastUpdateTimes = new Map<string, number>();
  private readonly UPDATE_DEBOUNCE_MS = 2000;

  private key(sessionId?: string): string {
    return sessionId ?? getTopicRuntimeContext()?.sessionId ?? MAIN_KEY;
  }

  public initialize(api: Api, chatId: number, sessionId?: string, threadId?: number): void {
    this.api = api;
    const key = this.key(sessionId);
    const existing = this.states.get(key);
    if (!existing) {
      const currentModel = getStoredModel();
      const isMain = !sessionId;
      this.states.set(key, {
        sessionId,
        chatId,
        threadId: threadId ?? (isMain ? getMainTelegramThreadIdSync(chatId) ?? undefined : undefined),
        currentAgent: getStoredAgent(),
        currentModel,
        contextInfo: null,
        variantName: formatVariantForButton(currentModel.variant || "default"),
        paused: sessionId ? isChatPaused(sessionId) : isChatPaused(),
      });
      return;
    }
    existing.chatId = chatId;
    if (threadId !== undefined) existing.threadId = threadId;
    if (!sessionId && existing.threadId === undefined) {
      existing.threadId = getMainTelegramThreadIdSync(chatId) ?? undefined;
    }
  }

  public bindTopic(api: Api, chatId: number, threadId: number, sessionId: string): void {
    this.initialize(api, chatId, sessionId, threadId);
  }

  private activeSessionId(sessionId?: string): string | undefined {
    return sessionId ?? getTopicRuntimeContext()?.sessionId;
  }

  private state(sessionId?: string): KeyboardState | undefined {
    return this.states.get(this.key(sessionId));
  }

  public updateAgent(agent: string, sessionId?: string): void {
    const state = this.state(sessionId);
    if (state) state.currentAgent = agent;
  }

  public updateModel(model: ModelInfo, sessionId?: string): void {
    const state = this.state(sessionId);
    if (!state) return;
    state.currentModel = model;
    state.variantName = formatVariantForButton(model.variant || "default");
  }

  public updateVariant(variantId: string, sessionId?: string): void {
    const state = this.state(sessionId);
    if (state) state.variantName = formatVariantForButton(variantId);
  }

  public setPaused(paused: boolean, sessionId?: string): void {
    const state = this.state(sessionId);
    if (state) state.paused = paused;
  }

  public updateContext(tokensUsed: number, tokensLimit: number, sessionId?: string): void {
    const state = this.state(sessionId);
    if (state) state.contextInfo = { tokensUsed, tokensLimit };
  }

  public clearContext(sessionId?: string): void {
    const state = this.state(sessionId);
    if (state) state.contextInfo = null;
  }

  public getContextInfo(sessionId?: string): ContextInfo | null {
    return this.state(sessionId)?.contextInfo ?? null;
  }

  private buildKeyboard(sessionId?: string) {
    const state = this.state(sessionId);
    const effectiveSessionId = this.activeSessionId(sessionId);
    const running = effectiveSessionId
      ? assistantRunState.hasActiveRun(effectiveSessionId)
      : assistantRunState.hasActiveRuns();
    const isTopic = Boolean(state?.sessionId && state.threadId !== undefined);

    if (isTopic) {
      const topicState = state;
      if (!topicState) return createMainKeyboard({ providerID: "", modelID: "" }, { running, isTopic: false });
      const paused = topicState.sessionId ? isChatPaused(topicState.sessionId) : topicState.paused;
      return createTopicKeyboard({ paused });
    }

    if (!state) {
      return createMainKeyboard(
        { providerID: "", modelID: "" },
        { paused: false, running, compactOutputMode: getCompactOutputMode(), isTopic: false },
      );
    }

    return createMainKeyboard(state.currentModel, {
      queuedPromptLabels: getQueuedPromptButtonLabels(effectiveSessionId),
      paused: state.paused,
      running,
      compactOutputMode: getCompactOutputMode(),
      isTopic: false,
    });
  }

  public async sendKeyboardUpdate(chatId?: number, force = false, sessionId?: string): Promise<void> {
    if (!this.api) return;
    const effectiveSessionId = this.activeSessionId(sessionId);
    const state = this.state(effectiveSessionId);
    const targetChatId = chatId ?? state?.chatId;
    if (!targetChatId) return;

    const key = this.key(effectiveSessionId);
    const now = Date.now();
    const previous = this.lastUpdateTimes.get(key) ?? 0;
    if (!force && now - previous < this.UPDATE_DEBOUNCE_MS) return;
    this.lastUpdateTimes.set(key, now);

    try {
      const options: Record<string, unknown> = {
        reply_markup: this.buildKeyboard(effectiveSessionId),
      };
      if (state?.threadId !== undefined) options.message_thread_id = state.threadId;
      await this.api.sendMessage(targetChatId, t("keyboard.updated"), options as never);
    } catch (err) {
      logger.error("[KeyboardManager] Failed to send keyboard update:", err);
    }
  }

  public getKeyboard(sessionId?: string) {
    return this.state(sessionId) ? this.buildKeyboard(sessionId) : undefined;
  }

  public getState(sessionId?: string): KeyboardState | undefined {
    return this.state(sessionId);
  }

  public isInitialized(sessionId?: string): boolean {
    return Boolean(this.state(sessionId));
  }

  public clearSession(sessionId: string): void {
    this.states.delete(this.key(sessionId));
    this.lastUpdateTimes.delete(this.key(sessionId));
  }
}

export const keyboardManager = new KeyboardManager();

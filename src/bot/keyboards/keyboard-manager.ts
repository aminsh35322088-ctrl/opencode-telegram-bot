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
import { logger } from "../../utils/logger.js";

const MAIN_KEY = "__main__";

function normalizeOutboundThreadId(threadId?: number): number | undefined {
  return typeof threadId === "number" && threadId > 1 ? threadId : undefined;
}

class KeyboardManager {
  private readonly states = new Map<string, KeyboardState>();
  private api: Api | null = null;
  private readonly lastUpdateTimes = new Map<string, number>();
  private readonly UPDATE_DEBOUNCE_MS = 2000;

  /** Keyboard identity is explicit: omitted sessionId always means Main. */
  private key(sessionId?: string): string { return sessionId ?? MAIN_KEY; }

  /** When no sessionId is given, inherit the scope from the active Topic runtime context. */
  private resolveSessionId(sessionId?: string): string | undefined {
    if (sessionId) return sessionId;
    return getTopicRuntimeContext()?.sessionId;
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
        threadId: normalizeOutboundThreadId(threadId ?? undefined),
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
    if (!sessionId && existing.threadId === undefined) existing.threadId = normalizeOutboundThreadId(undefined);
  }

  public bindTopic(api: Api, chatId: number, threadId: number, sessionId: string): void { this.initialize(api, chatId, sessionId, threadId); }
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
      return createTopicKeyboard({ paused, running, compactOutputMode: getCompactOutputMode() });
    }
    if (!state) return createMainKeyboard({ providerID: "", modelID: "" }, { paused: false, running: false, compactOutputMode: getCompactOutputMode(), isTopic: false });
    return createMainKeyboard(state.currentModel, {
      queuedPromptLabels: getQueuedPromptButtonLabels(),
      paused: false,
      running: false,
      compactOutputMode: getCompactOutputMode(),
      isTopic: false,
    });
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
      const options: Record<string, unknown> = { reply_markup: this.buildKeyboard(resolvedSessionId) };
      const threadId = normalizeOutboundThreadId(state?.threadId);
      if (threadId !== undefined) options.message_thread_id = threadId;
      else if (resolvedSessionId) {
        const fallbackThreadId = this.getThreadIdForSession(resolvedSessionId);
        const normalizedFallback = normalizeOutboundThreadId(fallbackThreadId);
        if (normalizedFallback !== undefined) options.message_thread_id = normalizedFallback;
      }
      await this.api.sendMessage(targetChatId, t("keyboard.updated"), options as never);
    } catch (err) { logger.error("[KeyboardManager] Failed to send keyboard update:", err); }
  }

  public getKeyboard(sessionId?: string) { const resolved = this.resolveSessionId(sessionId); return this.state(resolved) ? this.buildKeyboard(resolved) : undefined; }
  public getState(sessionId?: string): KeyboardState | undefined { return this.state(sessionId); }
  public isInitialized(sessionId?: string): boolean { return Boolean(this.state(sessionId)); }
  public getThreadIdForSession(sessionId?: string): number | undefined { return this.state(sessionId)?.threadId; }
  public clearSession(sessionId: string): void { this.states.delete(this.key(sessionId)); this.lastUpdateTimes.delete(this.key(sessionId)); }
}

export const keyboardManager = new KeyboardManager();

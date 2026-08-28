import type { Api } from "grammy";
import { createMainKeyboard } from "./main-reply-keyboard.js";
import { getQueuedPromptButtonLabels } from "./queued-prompt-button.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import type { ModelInfo } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import type { ContextInfo, KeyboardState } from "./keyboard-types.js";
import { t } from "../../i18n/index.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";

class KeyboardManager {
  private state: KeyboardState | null = null;
  private api: Api | null = null;
  private chatId: number | null = null;
  private lastUpdateTime = 0;
  private readonly UPDATE_DEBOUNCE_MS = 2000;

  public initialize(api: Api, chatId: number): void {
    this.api = api;
    this.chatId = chatId;
    if (!this.state) {
      const currentModel = getStoredModel();
      this.state = {
        currentAgent: getStoredAgent(),
        currentModel,
        contextInfo: null,
        variantName: formatVariantForButton(currentModel.variant || "default"),
        paused: isChatPaused(),
      };
    }
  }

  public updateAgent(agent: string): void { if (this.state) this.state.currentAgent = agent; }
  public updateModel(model: ModelInfo): void {
    if (!this.state) return;
    this.state.currentModel = model;
    this.state.variantName = formatVariantForButton(model.variant || "default");
  }
  public updateVariant(variantId: string): void { if (this.state) this.state.variantName = formatVariantForButton(variantId); }
  public setPaused(paused: boolean): void { if (this.state) this.state.paused = paused; }
  public updateContext(tokensUsed: number, tokensLimit: number): void {
    if (this.state) this.state.contextInfo = { tokensUsed, tokensLimit };
  }
  public clearContext(): void { if (this.state) this.state.contextInfo = null; }
  public getContextInfo(): ContextInfo | null { return this.state?.contextInfo ?? null; }

  private buildKeyboard() {
    if (!this.state) {
      return createMainKeyboard("build", { providerID: "", modelID: "" }, undefined, undefined, [], false, assistantRunState.hasActiveRuns());
    }
    return createMainKeyboard(
      this.state.currentAgent,
      this.state.currentModel,
      this.state.contextInfo ?? undefined,
      this.state.variantName,
      getQueuedPromptButtonLabels(),
      this.state.paused,
      assistantRunState.hasActiveRuns(),
    );
  }

  public async sendKeyboardUpdate(chatId?: number): Promise<void> {
    if (!this.api) return;
    const targetChatId = chatId ?? this.chatId;
    if (!targetChatId) return;
    const now = Date.now();
    if (now - this.lastUpdateTime < this.UPDATE_DEBOUNCE_MS) return;
    this.lastUpdateTime = now;
    try {
      await this.api.sendMessage(targetChatId, t("keyboard.updated"), { reply_markup: this.buildKeyboard() });
    } catch (err) {
      logger.error("[KeyboardManager] Failed to send keyboard update:", err);
    }
  }

  public getKeyboard() { return this.state ? this.buildKeyboard() : undefined; }
  public getState(): KeyboardState | undefined { return this.state ?? undefined; }
  public isInitialized(): boolean { return this.state !== null; }
}

export const keyboardManager = new KeyboardManager();

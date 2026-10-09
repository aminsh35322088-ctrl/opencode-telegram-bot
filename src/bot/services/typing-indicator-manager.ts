import type { Api } from "grammy";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { logger } from "../../utils/logger.js";

const TYPING_REFRESH_MS = 4000;

type TypingApi = Pick<Api, "sendChatAction">;

type TypingState = {
  api: TypingApi;
  chatId: number;
  timer: ReturnType<typeof setInterval>;
};

class TypingIndicatorManager {
  private readonly states = new Map<string, TypingState>();

  start(sessionId: string, api: TypingApi, chatId: number): void {
    if (!sessionId || !chatId) return;
    this.stop(sessionId, "restart");

    const timer = setInterval(() => {
      void this.tick(sessionId);
    }, TYPING_REFRESH_MS);
    timer.unref?.();

    this.states.set(sessionId, { api, chatId, timer });
    void this.tick(sessionId);
  }

  stop(sessionId: string, reason: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    clearInterval(state.timer);
    this.states.delete(sessionId);
    logger.debug(`[TypingIndicator] Stopped: session=${sessionId}, reason=${reason}`);
  }

  clearAll(reason: string): void {
    for (const state of this.states.values()) clearInterval(state.timer);
    if (this.states.size > 0) {
      logger.debug(`[TypingIndicator] Cleared: count=${this.states.size}, reason=${reason}`);
    }
    this.states.clear();
  }

  private async tick(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    if (!assistantRunState.hasActiveRun(sessionId)) {
      this.stop(sessionId, "run_inactive");
      return;
    }

    try {
      await state.api.sendChatAction(state.chatId, "typing");
    } catch (error) {
      logger.debug(`[TypingIndicator] Telegram typing refresh failed: session=${sessionId}`, error);
    }
  }
}

export const typingIndicatorManager = new TypingIndicatorManager();

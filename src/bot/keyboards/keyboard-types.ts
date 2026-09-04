import type { ModelInfo } from "../../app/types/model.js";

export interface ContextInfo {
  tokensUsed: number;
  tokensLimit: number;
}

/** Keyboard state owned by one OpenCode session / Telegram Topic. */
export interface KeyboardState {
  sessionId?: string;
  chatId?: number;
  threadId?: number;
  currentAgent: string;
  currentModel: ModelInfo;
  contextInfo: ContextInfo | null;
  variantName?: string;
  paused: boolean;
}

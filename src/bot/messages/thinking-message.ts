import type { ToolMessageBatcher } from "../../app/formatters/tool-message-batcher.js";
import { t } from "../../i18n/index.js";

type ThinkingBatcher = Pick<ToolMessageBatcher, "enqueueUniqueByPrefix">;

const THINKING_MESSAGE_PREFIX = "thinking_started";

export function deliverThinkingMessage(sessionId: string, batcher: ThinkingBatcher): void {
  const message = t("bot.thinking");
  batcher.enqueueUniqueByPrefix(sessionId, message, THINKING_MESSAGE_PREFIX);
}

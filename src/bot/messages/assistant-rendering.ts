import { getCompactOutputMode, getMessageFormatMode } from "../../app/stores/settings-store.js";
import { logger } from "../../utils/logger.js";
import { chunkPlainText, chunkTelegramRenderedBlocks } from "../render/chunker.js";
import { renderTelegramBlocks, renderTelegramParts, toRenderedBlocks } from "../render/pipeline.js";
import type { TelegramRenderedBlock, TelegramRenderedPart } from "../render/types.js";
import type { StreamingMessagePayload } from "../streaming/response-streamer.js";

export function createPlainRenderedParts(text: string): TelegramRenderedPart[] { return chunkPlainText(text); }

function useAssistantEntitiesFormat(): boolean { return getMessageFormatMode() === "markdown"; }

/** Compact mode reduces presentation noise without rewriting the model's meaning. */
export function normalizeAssistantReplyForDisplay(text: string): string {
  if (!getCompactOutputMode()) return text;
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderAssistantBlocksSafe(text: string): TelegramRenderedBlock[] {
  if (!text) return [];
  try {
    return renderTelegramBlocks(text);
  } catch (error) {
    logger.warn("[AssistantRender] Block rendering failed, falling back to plain streaming block", error);
    return toRenderedBlocks([{ type: "plain", text }]);
  }
}

export function renderAssistantFinalPartsSafe(text: string): TelegramRenderedPart[] {
  const displayText = normalizeAssistantReplyForDisplay(text);
  if (!displayText) return [];
  const formatMode = useAssistantEntitiesFormat() ? "blocks" : "raw";

  if (!useAssistantEntitiesFormat()) {
    const parts = createPlainRenderedParts(displayText);
    logger.debug("[AssistantRender] Built final assistant parts in raw mode", { formatMode, textLength: displayText.length, partCount: parts.length });
    return parts;
  }

  try {
    const parts = renderTelegramParts(displayText);
    logger.debug("[AssistantRender] Built final assistant parts in blocks mode", { formatMode, textLength: displayText.length, partCount: parts.length });
    return parts;
  } catch (error) {
    logger.warn("[AssistantRender] Part rendering failed, falling back to plain text parts", error);
    return createPlainRenderedParts(displayText);
  }
}

function getStableStreamingBoundary(messageText: string): number {
  if (!messageText) return 0;
  if (messageText.endsWith("\n\n")) return messageText.length;
  const lastBlockSeparatorIndex = messageText.lastIndexOf("\n\n");
  return lastBlockSeparatorIndex >= 0 ? lastBlockSeparatorIndex + 2 : 0;
}

export function buildStreamingBlocks(messageText: string): TelegramRenderedBlock[] {
  const stableBoundary = getStableStreamingBoundary(messageText);
  const blocks: TelegramRenderedBlock[] = [];
  if (stableBoundary > 0) blocks.push(...renderAssistantBlocksSafe(messageText.slice(0, stableBoundary)));
  const unstableTail = stableBoundary > 0 ? messageText.slice(stableBoundary) : messageText;
  if (unstableTail) blocks.push(...toRenderedBlocks([{ type: "plain", text: unstableTail }]));
  return blocks;
}

export function prepareAssistantStreamingPayload(messageText: string): StreamingMessagePayload | null {
  if (!messageText) return null;
  const formatMode = useAssistantEntitiesFormat() ? "blocks" : "raw";
  if (!useAssistantEntitiesFormat()) {
    const parts = createPlainRenderedParts(messageText);
    return parts.length > 0 ? { parts } : null;
  }
  const blocks = buildStreamingBlocks(messageText);
  const parts = chunkTelegramRenderedBlocks(blocks);
  logger.debug("[AssistantRender] Built streaming assistant payload", { formatMode, textLength: messageText.length, blockCount: blocks.length, partCount: parts.length });
  return parts.length > 0 ? { parts } : null;
}

export function prepareAssistantFinalStreamingPayload(messageText: string): StreamingMessagePayload | null {
  const parts = renderAssistantFinalPartsSafe(messageText);
  return parts.length > 0 ? { parts } : null;
}

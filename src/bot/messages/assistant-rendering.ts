import { getMessageFormatMode } from "../../app/stores/settings-store.js";
import { logger } from "../../utils/logger.js";
import { chunkPlainText } from "../render/chunker.js";
import { renderTelegramBlocks, renderTelegramParts } from "../render/pipeline.js";
import type { TelegramRenderedBlock, TelegramRenderedPart } from "../render/types.js";
import type { StreamingMessagePayload } from "../streaming/response-streamer.js";

export function createPlainRenderedParts(text: string): TelegramRenderedPart[] {
  return chunkPlainText(text);
}

function useAssistantEntitiesFormat(): boolean {
  return getMessageFormatMode() === "markdown";
}

/** Compact mode reduces presentation noise without rewriting the model's meaning. */
export function normalizeAssistantReplyForDisplay(text: string): string {
  return text;
}

function renderAssistantBlocksSafe(text: string): TelegramRenderedBlock[] {
  if (!text) return [];
  return renderTelegramBlocks(text);
}

export function renderAssistantFinalPartsSafe(text: string): TelegramRenderedPart[] {
  const displayText = normalizeAssistantReplyForDisplay(text);
  if (!displayText) return [];
  const formatMode = useAssistantEntitiesFormat() ? "blocks" : "raw";

  if (!useAssistantEntitiesFormat()) {
    const parts = createPlainRenderedParts(displayText);
    logger.debug("[AssistantRender] Built final assistant parts in raw mode", {
      formatMode,
      textLength: displayText.length,
      partCount: parts.length,
    });
    return parts;
  }

  const parts = renderTelegramParts(displayText);
  logger.debug("[AssistantRender] Built final assistant parts", {
    formatMode,
    textLength: displayText.length,
    partCount: parts.length,
  });
  return parts;
}

export function buildStreamingBlocks(messageText: string): TelegramRenderedBlock[] {
  return renderAssistantBlocksSafe(messageText);
}

export function prepareAssistantStreamingPayload(
  messageText: string,
): StreamingMessagePayload | null {
  if (!messageText) return null;
  const formatMode = useAssistantEntitiesFormat() ? "blocks" : "raw";
  if (!useAssistantEntitiesFormat()) {
    const parts = createPlainRenderedParts(messageText);
    return parts.length > 0 ? { parts } : null;
  }
  const parts = renderTelegramParts(messageText);
  logger.debug("[AssistantRender] Built streaming assistant payload", {
    formatMode,
    textLength: messageText.length,
    partCount: parts.length,
  });
  return parts.length > 0 ? { parts } : null;
}

export function prepareAssistantFinalStreamingPayload(
  messageText: string,
): StreamingMessagePayload | null {
  const parts = renderAssistantFinalPartsSafe(messageText);
  return parts.length > 0 ? { parts } : null;
}

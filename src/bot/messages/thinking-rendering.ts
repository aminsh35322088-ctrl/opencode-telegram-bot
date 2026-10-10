import { t } from "../../i18n/index.js";
import { DEFAULT_MAX_PART_CHARS } from "../render/limits.js";
import { splitTextIntoChunks } from "../render/text-splitter.js";
import type { TelegramRenderedPart, TelegramRichBlock } from "../render/types.js";
import type { StreamingMessagePayload } from "../streaming/response-streamer.js";

export interface ThinkingSection {
  id: string;
  title?: string | undefined;
  text: string;
}

interface ThinkingPayloadOptions {
  /** Final render is persisted as a normal expandable quotation. */
  final?: boolean;
}

function formatHeader(title?: string): string {
  const fallback = t("bot.thinking");
  const normalizedTitle = title?.trim();
  return normalizedTitle ? `${fallback} — ${normalizedTitle}` : fallback;
}

export function isLongThinking(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n");
  const lineCount = normalized.length === 0 ? 0 : normalized.split("\n").length;
  return normalized.length > 320 || lineCount > 4;
}

function quoteText(header: string, text: string) {
  return text
    ? [{ type: "bold" as const, text: header }, "\n", text]
    : { type: "bold" as const, text: header };
}

function createOpenThinkingBlock(header: string, text: string): TelegramRichBlock {
  return {
    type: "blockquote",
    blocks: [{ type: "paragraph", text: quoteText(header, text) }],
  };
}

function createCompletedThinkingBlock(
  header: string,
  text: string,
  long: boolean,
): TelegramRichBlock {
  return long
    ? { type: "expandable_blockquote", text: quoteText(header, text) }
    : createOpenThinkingBlock(header, text);
}

function createThinkingPart(
  header: string,
  text: string,
  final: boolean,
  long: boolean,
): TelegramRenderedPart {
  const fallbackText = text ? `${header}\n${text}` : header;
  return {
    blocks: [
      final
        ? createCompletedThinkingBlock(header, text, long)
        : createOpenThinkingBlock(header, text),
    ],
    fallbackText,
    source: "blocks",
  };
}

/**
 * Visible reasoning summaries stay open while a run is active. On completion,
 * short summaries remain open while long summaries become expandable. Raw
 * provider chain-of-thought is not an input to this renderer.
 */
export function prepareThinkingPayload(
  sections: ThinkingSection[],
  options: ThinkingPayloadOptions = {},
): StreamingMessagePayload | null {
  const final = options.final ?? false;
  const parts: TelegramRenderedPart[] = [];

  for (const section of sections) {
    const header = formatHeader(section.title);
    const text = section.text.replace(/\r\n/g, "\n").trimEnd();
    const textLimit = Math.max(1, DEFAULT_MAX_PART_CHARS - header.length - 1);
    const chunks = text ? splitTextIntoChunks(text, textLimit) : [""];
    const long = isLongThinking(text);

    for (const chunk of chunks) {
      parts.push(createThinkingPart(header, chunk, final, long));
    }
  }

  return parts.length > 0 ? { parts } : null;
}

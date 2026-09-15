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

function createThinkingBlock(header: string, text: string): TelegramRichBlock {
  return {
    type: "thinking",
    text: text ? `${header}\n${text}` : header,
  };
}

function createFinalThinkingBlock(header: string, text: string): TelegramRichBlock {
  return {
    type: "expandable_blockquote",
    blocks: [
      {
        type: "paragraph",
        text: text
          ? [{ type: "bold", text: header }, "\n", text]
          : { type: "bold", text: header },
      },
    ],
  };
}

function createThinkingPart(
  header: string,
  text: string,
  final: boolean,
): TelegramRenderedPart {
  const fallbackText = text ? `${header}\n${text}` : header;
  return {
    blocks: [final ? createFinalThinkingBlock(header, text) : createThinkingBlock(header, text)],
    fallbackText,
    source: "blocks",
  };
}

/**
 * While a model run is active, reasoning is represented by Telegram's native
 * `thinking` rich block and therefore must travel through sendRichMessageDraft.
 * On completion the same visible content is converted to a persistent,
 * collapsible rich quotation because `thinking` blocks are draft-only.
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

    for (const chunk of chunks) {
      parts.push(createThinkingPart(header, chunk, final));
    }
  }

  return parts.length > 0 ? { parts } : null;
}

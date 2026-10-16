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

function normalizeThinkingText(text: string): string {
  return text
    .replace(/<\/?think(?:ing)?\s*>/gi, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function combineThinkingSections(sections: ThinkingSection[]): { header: string; text: string } {
  const normalizedSections = sections.map((section) => ({
    title: section.title?.trim() || "",
    text: normalizeThinkingText(section.text),
  }));
  const titles = [...new Set(normalizedSections.map((section) => section.title).filter(Boolean))];
  const primaryTitle = titles.length === 1 ? titles[0] : undefined;
  let previousTitle = "";

  const text = normalizedSections
    .map((section) => {
      if (!section.text) return "";

      const title = primaryTitle ? "" : section.title !== previousTitle ? section.title : "";
      previousTitle = section.title;
      return title ? `${title}\n${section.text}` : section.text;
    })
    .filter(Boolean)
    .join("\n\n");

  return { header: formatHeader(primaryTitle), text };
}

function quoteText(header: string, text: string) {
  return text
    ? [{ type: "bold" as const, text: header }, "\n", text]
    : { type: "bold" as const, text: header };
}

function createOpenThinkingBlock(header: string, text: string): TelegramRichBlock {
  return { type: "thinking", text: text ? `${header}\n${text}` : header };
}

function createCompletedThinkingBlock(header: string, text: string): TelegramRichBlock {
  return { type: "expandable_blockquote", text: quoteText(header, text) };
}

function createThinkingPart(
  header: string,
  text: string,
  final: boolean,
): TelegramRenderedPart {
  const fallbackText = text ? `${header}\n${text}` : header;
  return {
    blocks: [final ? createCompletedThinkingBlock(header, text) : createOpenThinkingBlock(header, text)],
    fallbackText,
    source: "blocks",
  };
}

/**
 * Visible reasoning stays in one native draft while a run is active so
 * Telegram can animate updates to the same draft ID. On completion the
 * sections are persisted together as one expandable quotation.
 */
export function prepareThinkingPayload(
  sections: ThinkingSection[],
  options: ThinkingPayloadOptions = {},
): StreamingMessagePayload | null {
  const final = options.final ?? false;
  if (sections.length === 0) return null;

  const { header, text } = combineThinkingSections(sections);
  const textLimit = Math.max(1, DEFAULT_MAX_PART_CHARS - header.length - 1);
  const chunks = text ? splitTextIntoChunks(text, textLimit) : [""];
  const parts: TelegramRenderedPart[] = chunks.map((chunk) => createThinkingPart(header, chunk, final));

  return parts.length > 0 ? { parts } : null;
}

/** Native draft content shown immediately, before the provider emits reasoning. */
export function prepareThinkingPlaceholderPayload(): StreamingMessagePayload {
  const part = createThinkingPart(formatHeader(), "", false);
  return { parts: [part] };
}

import {
  renderTelegramMessageDocument,
  renderTelegramMessageMarkdown,
} from "@opencode-telegram/native-runtime";
import { config, type MessageFormatMode } from "../../config.js";

export function formatSummary(text: string): string[] {
  return formatSummaryWithMode(text, config.bot.messageFormatMode);
}

/** Split semantic text before serializing, never serialized Markdown delimiters. */
export function formatSummaryWithMode(
  text: string,
  mode: MessageFormatMode,
  maxLength = 4096,
): string[] {
  if (!text.trim()) return [];
  const maxCharacters = Math.min(4096, Math.max(2, Math.floor(maxLength)));
  if (mode === "markdown")
    return renderTelegramMessageMarkdown(text, { maxCharacters, allowTelegramUserLinks: true }).map(
      (part) => part.markdownV2,
    );
  return renderTelegramMessageDocument(
    { blocks: [{ type: "paragraph", text }] },
    { maxCharacters },
  ).map((part) => part.text);
}

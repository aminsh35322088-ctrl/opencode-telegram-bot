import { renderTelegramMessageMarkdown } from "@opencode-telegram/native-runtime";

/** Compatibility entry point; Core owns parsing and context-aware serialization. */
export function convertToTelegramMarkdownV2(markdown: string): string {
  return renderTelegramMessageMarkdown(markdown, { allowTelegramUserLinks: true })
    .map((part) => part.markdownV2)
    .join("\n\n");
}

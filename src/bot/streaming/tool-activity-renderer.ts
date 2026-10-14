import {
  renderTelegramRichDocument,
  type AgentDocument,
} from "@opencode-telegram/native-runtime";
import type { TelegramRenderedPart } from "../render/types.js";

const ACTIVITY_AUTHORIZATION = /(authorization\s*:\s*bearer\s+)[^\s]+/gi;
const ACTIVITY_SECRET_ASSIGNMENT = /(\b(?:[a-z0-9_-]*?(?:api[_-]?key|token|password|secret|credential)[a-z0-9_-]*)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi;
const ACTIVITY_TELEGRAM_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;

const ACTIVITY_SUMMARY = "🛠 Activity";

export function redactToolActivity(input: string): string {
  return input
    .trim()
    .replace(ACTIVITY_AUTHORIZATION, "$1[REDACTED]")
    .replace(ACTIVITY_SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(ACTIVITY_TELEGRAM_TOKEN, "[REDACTED]");
}

/**
 * Build the trusted run-activity presentation from Bot-owned state while
 * delegating Telegram RichBlock semantics to Core/native-runtime.
 *
 * Model/tool text is inserted as a plain AgentDocument paragraph rather than
 * reparsed as HTML/Markdown, so a tool line cannot manufacture interactive
 * Telegram blocks. The same redacted body is used for the rich and fallback
 * representations.
 */
export function renderToolActivity(input: string): TelegramRenderedPart {
  const body = redactToolActivity(input);
  const document: AgentDocument = {
    blocks: [
      {
        type: "details",
        summary: ACTIVITY_SUMMARY,
        blocks: [{ type: "paragraph", text: body }],
      },
    ],
  };
  const rich = renderTelegramRichDocument(document, { draft: false });

  return {
    blocks: rich.blocks ?? [],
    fallbackText: body ? `${ACTIVITY_SUMMARY}\n\n${body}` : ACTIVITY_SUMMARY,
    source: "blocks",
  };
}

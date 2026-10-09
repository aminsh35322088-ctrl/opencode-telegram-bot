import {
  chunkAgentDocument,
  parseMarkdownDocument,
  sanitizeAgentDocumentBidi,
  withAgentDocumentDirection,
  renderTelegramMessageDocument,
  renderTelegramRichDocument,
} from "@opencode-telegram/native-runtime";
import { toBlockPlainText } from "./block-plain-text.js";
import { splitOversizeTelegramBlocks, type BlockSplitLimits } from "./block-splitter.js";
import type { TelegramChunkerOptions } from "./chunker.js";
import { liftTextListContent, toRichBlock } from "./rich-blocks.js";
import type { TelegramBlock, TelegramRenderedBlock, TelegramRichBlock } from "./types.js";
import type { TelegramRenderedPart } from "./types.js";

/**
 * Bot API 10.3 can render native tables with tighter cell padding. Markdown
 * tables are inherently dense data, so opt into compact presentation at the
 * final render boundary while keeping the parser and fallback text unchanged.
 */
function applyRichBlockPresentation(block: TelegramRichBlock): TelegramRichBlock {
  if (block.type === "table") {
    return { ...block, is_compact: true };
  }
  return block;
}

/**
 * Lifts native content out of lists that are written as text, splits blocks
 * that exceed the per-message budgets, then pairs every block with its native
 * rich form and its plain-text projection.
 */
export function toRenderedBlocks(
  blocks: TelegramBlock[],
  limits?: Partial<BlockSplitLimits>,
): TelegramRenderedBlock[] {
  return splitOversizeTelegramBlocks(liftTextListContent(blocks), limits).map((block) => ({
    block: applyRichBlockPresentation(toRichBlock(block)),
    plainText: toBlockPlainText(block),
  }));
}

export function renderTelegramBlocks(
  markdown: string,
  limits?: Partial<BlockSplitLimits>,
): TelegramRenderedBlock[] {
  const document = withAgentDocumentDirection(
    sanitizeAgentDocumentBidi(parseMarkdownDocument(markdown, { allowTelegramUserLinks: true })),
  );
  return document.blocks.flatMap((block) => {
    const chunks = chunkAgentDocument(
      { ...document, blocks: [block] },
      {
        maxCharacters: Math.min(3800, limits?.maxChars ?? 3800),
        maxBlocks: Math.min(480, limits?.maxBlocks ?? 480),
      },
    );
    return chunks.flatMap((chunk) => {
      const parts = renderTelegramMessageDocument(chunk, {
        maxCharacters: Math.min(3800, limits?.maxChars ?? 3800),
      });
      return parts.flatMap((part) =>
        (
          renderTelegramRichDocument(parts.length === 1 ? chunk : part.document, { draft: false })
            .blocks ?? []
        ).map((richBlock, index) => ({
          block: applyRichBlockPresentation(richBlock),
          plainText: index === 0 ? part.text : "",
        })),
      );
    });
  });
}

export function renderTelegramParts(
  markdown: string,
  options?: TelegramChunkerOptions,
): TelegramRenderedPart[] {
  // Core owns Markdown parsing, semantic chunking and entity offsets. Keep
  // native blocks and normal fallback tied to the same independently valid IR.
  const document = withAgentDocumentDirection(
    sanitizeAgentDocumentBidi(parseMarkdownDocument(markdown, { allowTelegramUserLinks: true })),
  );
  return chunkAgentDocument(document, {
    maxCharacters: Math.min(3800, options?.maxChars ?? 3800),
    maxBlocks: Math.min(480, options?.maxBlocks ?? 480),
  }).flatMap((documentChunk) => {
    const parts = renderTelegramMessageDocument(documentChunk, {
      maxCharacters: Math.min(3800, options?.maxChars ?? 3800),
    });
    return parts.map((part) => ({
      blocks: (
        renderTelegramRichDocument(parts.length === 1 ? documentChunk : part.document, {
          draft: false,
        }).blocks ?? []
      ).map(applyRichBlockPresentation),
      fallbackText: part.text,
      html: part.html,
      markdownV2: part.markdownV2,
      entities: part.entities,
      source: "blocks" as const,
    }));
  });
}

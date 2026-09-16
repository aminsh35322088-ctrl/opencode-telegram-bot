import { parseTelegramBlocks } from "./block-parser.js";
import { toBlockPlainText } from "./block-plain-text.js";
import { splitOversizeTelegramBlocks, type BlockSplitLimits } from "./block-splitter.js";
import { chunkTelegramRenderedBlocks, type TelegramChunkerOptions } from "./chunker.js";
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
  return toRenderedBlocks(parseTelegramBlocks(markdown), limits);
}

export function renderTelegramParts(
  markdown: string,
  options?: TelegramChunkerOptions,
): TelegramRenderedPart[] {
  return chunkTelegramRenderedBlocks(renderTelegramBlocks(markdown, options), options);
}

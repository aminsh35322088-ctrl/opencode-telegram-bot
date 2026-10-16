export interface ParsedInlineThinking {
  /** Text that belongs in the assistant's user-visible answer. */
  answerText: string;
  /** Text that belongs in the live and completed reasoning block. */
  thinkingText: string;
  /** True while the provider is still inside an inline reasoning block. */
  isThinking: boolean;
  /** True when a complete or partial provider think marker was observed. */
  hasThinkMarker: boolean;
}

const THINK_MARKER = /<\/?think(?:ing)?\s*>/gi;
const THINK_MARKERS = ["<think>", "</think>", "<thinking>", "</thinking>"];

function getTrailingPartialMarkerStart(text: string): number | null {
  const start = text.lastIndexOf("<");
  if (start < 0) return null;

  const suffix = text.slice(start).toLowerCase();
  if (suffix.length < 2) return null;
  if (THINK_MARKERS.some((marker) => marker.length > suffix.length && marker.startsWith(suffix))) {
    return start;
  }

  return null;
}

/**
 * Splits inline provider reasoning from answer text. OpenCode normally sends
 * reasoning as its own part, but some providers serialize it into text with
 * think delimiters. A few emit only closing delimiters; in that format each
 * delimiter toggles between reasoning and answer, so the first delimiter can
 * either close a prefix or open a leading reasoning block.
 */
export function parseInlineThinking(
  text: string,
  options: { final?: boolean } = {},
): ParsedInlineThinking {
  const final = options.final ?? false;
  const partialStart = getTrailingPartialMarkerStart(text);
  const scanText = partialStart === null ? text : text.slice(0, partialStart);
  const tokens = [...scanText.matchAll(THINK_MARKER)];
  const hasOpeningMarker = tokens.some((token) => !token[0]?.startsWith("</"));
  const hasThinkMarker = tokens.length > 0 || partialStart !== null;

  if (!hasThinkMarker) {
    return {
      answerText: scanText,
      thinkingText: "",
      isThinking: false,
      hasThinkMarker: false,
    };
  }

  let answerText = "";
  let thinkingText = "";
  let cursor = 0;
  let isThinking = false;

  // Some provider streams start with `</think>` and then emit their thoughts,
  // followed by another `</think>` before the actual answer. With no opening
  // marker in that stream, treat an initial non-empty prefix as an implicit
  // reasoning block and an initial marker at offset zero as its opener.
  if (!hasOpeningMarker) {
    const firstToken = tokens[0];
    const firstStart = firstToken?.index ?? scanText.length;
    isThinking = firstStart > 0 && scanText.slice(0, firstStart).trim().length > 0;
  }

  for (const token of tokens) {
    const marker = token[0] ?? "";
    const start = token.index ?? cursor;
    const content = scanText.slice(cursor, start);
    if (isThinking) thinkingText += content;
    else answerText += content;

    if (marker.startsWith("</")) {
      if (hasOpeningMarker) {
        isThinking = false;
      } else {
        isThinking = !isThinking;
      }
    } else {
      isThinking = true;
    }
    cursor = start + marker.length;
  }

  const tail = scanText.slice(cursor);
  if (isThinking) thinkingText += tail;
  else answerText += tail;

  if (final) {
    isThinking = false;
  }

  return {
    answerText,
    thinkingText,
    isThinking,
    hasThinkMarker,
  };
}

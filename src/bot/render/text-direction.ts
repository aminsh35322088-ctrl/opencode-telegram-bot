export type TextDirection = "rtl" | "ltr" | "neutral";

const LETTER_RE = /\p{Letter}/u;
const RTL_SCRIPT_RE = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * A Latin-leading block can still be predominantly RTL (for example a Persian
 * checklist heading that starts with "S" or "PR"). This threshold is only a
 * rescue after first-strong selected LTR; normal RTL-leading prose never needs
 * the ratio fallback.
 */
const RTL_RESCUE_RATIO = 0.3;

/**
 * A lower mixed-content floor is useful when a Persian sentence opens with a
 * long foreign label but closes in Persian. Requiring the last strong letter to
 * be RTL prevents an English sentence that merely quotes one Persian phrase
 * from being flipped.
 */
const RTL_CLOSING_RESCUE_RATIO = 0.15;

function strongDirection(char: string): Exclude<TextDirection, "neutral"> | null {
  if (!LETTER_RE.test(char)) {
    return null;
  }

  return RTL_SCRIPT_RE.test(char) ? "rtl" : "ltr";
}

/**
 * Resolve a stable base direction for Telegram rich messages.
 *
 * Numbers and punctuation are intentionally neutral. Existing bidi control
 * characters are ignored during classification so generated content cannot
 * spoof the detector. First-strong is the primary signal (matching the Unicode
 * bidi model). Ratio and last-strong are only rescue signals for mixed text
 * that starts with a Latin command/label but is structurally Persian.
 */
export function resolveTextDirection(text: string): TextDirection {
  const normalized = text.replace(BIDI_CONTROL_RE, "");
  let firstStrong: Exclude<TextDirection, "neutral"> | null = null;
  let lastStrong: Exclude<TextDirection, "neutral"> | null = null;
  let rtlLetters = 0;
  let ltrLetters = 0;

  for (const char of normalized) {
    const direction = strongDirection(char);
    if (!direction) {
      continue;
    }

    firstStrong ??= direction;
    lastStrong = direction;
    if (direction === "rtl") {
      rtlLetters += 1;
    } else {
      ltrLetters += 1;
    }
  }

  if (!firstStrong) {
    return "neutral";
  }

  if (firstStrong === "rtl") {
    return "rtl";
  }

  if (rtlLetters === 0) {
    return "ltr";
  }

  const directionalLetters = rtlLetters + ltrLetters;
  const rtlRatio = rtlLetters / directionalLetters;

  if (rtlRatio >= RTL_RESCUE_RATIO) {
    return "rtl";
  }

  if (lastStrong === "rtl" && rtlRatio >= RTL_CLOSING_RESCUE_RATIO) {
    return "rtl";
  }

  return "ltr";
}

export function shouldRenderRtl(text: string): boolean {
  return resolveTextDirection(text) === "rtl";
}

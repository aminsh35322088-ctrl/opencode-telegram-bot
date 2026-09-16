export type TextDirection = "rtl" | "ltr" | "neutral";

const LETTER_RE = /\p{Letter}/u;
const RTL_SCRIPT_RE = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * A Latin-leading block can still be predominantly RTL (for example a Persian
 * checklist heading that starts with "S" or "PR"). One third keeps short
 * foreign labels from flipping an otherwise RTL paragraph while leaving a
 * genuinely LTR sentence LTR.
 */
const RTL_RESCUE_RATIO = 1 / 3;

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
 * spoof the detector. The first strong letter is the primary signal (matching
 * the Unicode bidi model); the ratio is only a rescue for short LTR labels at
 * the beginning of otherwise RTL text.
 */
export function resolveTextDirection(text: string): TextDirection {
  const normalized = text.replace(BIDI_CONTROL_RE, "");
  let firstStrong: Exclude<TextDirection, "neutral"> | null = null;
  let rtlLetters = 0;
  let ltrLetters = 0;

  for (const char of normalized) {
    const direction = strongDirection(char);
    if (!direction) {
      continue;
    }

    firstStrong ??= direction;
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
  return rtlLetters / directionalLetters >= RTL_RESCUE_RATIO ? "rtl" : "ltr";
}

export function shouldRenderRtl(text: string): boolean {
  return resolveTextDirection(text) === "rtl";
}

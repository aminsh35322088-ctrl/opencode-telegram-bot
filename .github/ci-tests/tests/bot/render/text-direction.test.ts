import { describe, expect, it } from "vitest";
import {
  resolveTextDirection,
  shouldRenderRtl,
} from "../../../src/bot/render/text-direction.js";

describe("bot/render/text-direction", () => {
  it("marks Persian prose with embedded Telegram commands and English labels as RTL", () => {
    const text = [
      "🧭 S — داشبورد /session (PR #78)",
      "1. /session در تاپیک فعال → کارت با State، Tasks، Changes، Sub-sessions ببینید.",
      "2. وسط کار /session بزنید → State=busy و شمار Tasks/Changes واقعی.",
    ].join("\n");

    expect(resolveTextDirection(text)).toBe("rtl");
    expect(shouldRenderRtl(text)).toBe(true);
  });

  it("rescues a Latin-leading label when the rest of the block is predominantly Persian", () => {
    expect(resolveTextDirection("S — داشبورد جلسه و وضعیت اجرای تسک را نشان بده")).toBe("rtl");
  });

  it("keeps genuinely English mixed text LTR", () => {
    expect(resolveTextDirection("State is busy; وضعیت: busy")).toBe("ltr");
    expect(shouldRenderRtl("State is busy; وضعیت: busy")).toBe(false);
  });

  it("keeps code-like English text LTR", () => {
    expect(resolveTextDirection("npm install && git status")).toBe("ltr");
  });

  it("treats digits and punctuation as neutral instead of RTL", () => {
    expect(resolveTextDirection("2026 / 09 / 16 — #78")).toBe("neutral");
  });

  it("ignores explicit bidi controls while detecting the base direction", () => {
    expect(resolveTextDirection("\u202EEnglish only\u202C")).toBe("ltr");
    expect(resolveTextDirection("\u2066فارسی و متن\u2069")).toBe("rtl");
  });
});

import { describe, expect, it } from "vitest";

import { prepareThinkingPayload } from "../../../src/bot/messages/thinking-rendering.js";
import { DEFAULT_MAX_PART_CHARS } from "../../../src/bot/render/limits.js";
import { t } from "../../../src/i18n/index.js";
import { defined } from "../../helpers/defined.js";

describe("bot/messages/thinking-rendering", () => {
  it("renders live reasoning as Telegram's native thinking block", () => {
    const header = `${t("bot.thinking")} — Analysis`;

    const payload = prepareThinkingPayload([
      { id: "r1", title: "Analysis", text: "Line one\nLine two" },
    ]);

    expect(payload?.parts).toHaveLength(1);
    const firstPart = defined(payload?.parts[0]);
    expect(firstPart.source).toBe("blocks");
    expect(firstPart.blocks).toEqual([
      { type: "thinking", text: `${header}\nLine one\nLine two` },
    ]);
    expect(firstPart.fallbackText).toBe(`${header}\nLine one\nLine two`);
    expect(firstPart.entities).toBeUndefined();
  });

  it("falls back to the bare header when a section has no title", () => {
    const payload = prepareThinkingPayload([{ id: "r1", text: "A" }]);

    expect(defined(payload?.parts[0]).fallbackText).toBe(`${t("bot.thinking")}\nA`);
  });

  it("uses the native thinking block while the model is still reasoning", () => {
    const payload = prepareThinkingPayload([{ id: "r1", text: "Line one" }]);

    expect(defined(payload?.parts[0]?.blocks?.[0]).type).toBe("thinking");
  });

  it("converts completed reasoning to an expandable blockquote", () => {
    const header = t("bot.thinking");
    const payload = prepareThinkingPayload([{ id: "r1", text: "Line one" }], { final: true });

    expect(defined(payload?.parts[0]?.blocks?.[0])).toEqual({
      type: "expandable_blockquote",
      text: [{ type: "bold", text: header }, "\n", "Line one"],
    });
  });

  it("emits one part per reasoning section, in order", () => {
    const payload = prepareThinkingPayload([
      { id: "r1", title: "First", text: "A" },
      { id: "r2", title: "Second", text: "B" },
    ]);

    expect(payload?.parts.map((part) => part.fallbackText)).toEqual([
      `${t("bot.thinking")} — First\nA`,
      `${t("bot.thinking")} — Second\nB`,
    ]);
  });

  it("leaves markdown inside the reasoning untouched", () => {
    const text = "- one\n- two";
    const payload = prepareThinkingPayload([{ id: "r1", text }]);

    expect(defined(payload?.parts[0]).fallbackText).toBe(`${t("bot.thinking")}\n${text}`);
  });

  it("normalizes line endings and trims the trailing whitespace", () => {
    const payload = prepareThinkingPayload([{ id: "r1", text: "one\r\ntwo\n\n" }]);

    expect(defined(payload?.parts[0]).fallbackText).toBe(`${t("bot.thinking")}\none\ntwo`);
  });

  it("splits oversized rich reasoning while repeating the header", () => {
    const header = t("bot.thinking");
    const text = Array.from({ length: 1000 }, (_, index) => `line ${index} ${"y".repeat(40)}`).join(
      "\n",
    );

    const payload = prepareThinkingPayload([{ id: "r1", text }], { final: true });
    const parts = payload?.parts ?? [];

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.fallbackText.startsWith(`${header}\n`)).toBe(true);
      expect(part.fallbackText.length).toBeLessThanOrEqual(DEFAULT_MAX_PART_CHARS);
      expect(defined(part.blocks[0]).type).toBe("expandable_blockquote");
    }

    const joined = parts.map((part) => part.fallbackText.slice(header.length + 1)).join("");
    expect(joined).toBe(text);
  });

  it("keeps an empty section as a native thinking header", () => {
    const header = `${t("bot.thinking")} — Empty`;
    const payload = prepareThinkingPayload([{ id: "r1", title: "Empty", text: "" }]);

    expect(defined(payload?.parts[0]).fallbackText).toBe(header);
    expect(defined(payload?.parts[0]).blocks).toEqual([{ type: "thinking", text: header }]);
  });

  it("returns no payload without sections", () => {
    expect(prepareThinkingPayload([])).toBeNull();
  });
});

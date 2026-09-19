import { describe, expect, it } from "vitest";

import { toRichText } from "../../../src/bot/render/rich-blocks.js";

describe("bot/render/rich-link-safety", () => {
  it.each([
    "https://example.com/path?q=1",
    "http://example.com",
    "tg://resolve?domain=telegram",
    "mailto:test@example.com",
    "tel:+491234567",
  ])("keeps Telegram-safe link protocol %s", (url) => {
    expect(
      toRichText([{ type: "link", text: [{ type: "text", text: "open" }], url }]),
    ).toEqual({ type: "url", text: "open", url });
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/test",
    "/relative/path",
    "#local-anchor",
  ])("drops unsupported link target %s while preserving visible text", (url) => {
    expect(
      toRichText([{ type: "link", text: [{ type: "bold", children: [{ type: "text", text: "safe" }] }], url }]),
    ).toEqual({ type: "bold", text: "safe" });
  });

  it("drops overlong URLs instead of risking a whole-message rejection", () => {
    const url = `https://example.com/${"x".repeat(2_100)}`;
    expect(
      toRichText([{ type: "link", text: [{ type: "text", text: "visible" }], url }]),
    ).toBe("visible");
  });
});

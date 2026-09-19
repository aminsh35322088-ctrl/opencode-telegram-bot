import { describe, expect, it, vi } from "vitest";

import { sendRenderedBotPart } from "../../../src/bot/messages/telegram-text.js";
import { buildSourcePreservingRichHtml } from "../../../src/bot/render/rich-html-fallback.js";
import type { TelegramRenderedPart } from "../../../src/bot/render/types.js";

function badRequestError(message: string): Error & { error_code: number } {
  return Object.assign(new Error(message), { error_code: 400 });
}

const richPart: TelegramRenderedPart = {
  blocks: [{ type: "paragraph", text: { type: "bold", text: "Hello" } }],
  fallbackText: 'Hello <b> & "world"',
  source: "blocks",
};

describe("bot/messages/rich HTML fallback", () => {
  it("escapes source text instead of letting it inject Rich HTML", () => {
    expect(buildSourcePreservingRichHtml('<script>x</script> & "q"')).toBe(
      "<p>&lt;script&gt;x&lt;/script&gt; &amp; &quot;q&quot;</p>",
    );
    expect(buildSourcePreservingRichHtml("<tag>", { preformatted: true })).toBe(
      "<pre>&lt;tag&gt;</pre>",
    );
  });

  it("recovers a rejected native block payload with safe Rich HTML before plain text", async () => {
    const sendMessage = vi.fn();
    const sendRichMessage = vi
      .fn()
      .mockRejectedValueOnce(badRequestError("Bad Request: RICH_BLOCK_INVALID"))
      .mockResolvedValueOnce({ message_id: 77 });

    await expect(
      sendRenderedBotPart({
        api: { sendMessage, sendRichMessage },
        chatId: 100,
        part: richPart,
      }),
    ).resolves.toMatchObject({ messageId: 77, degradedToPlain: undefined });

    expect(sendRichMessage).toHaveBeenCalledTimes(2);
    expect(sendRichMessage).toHaveBeenNthCalledWith(
      2,
      100,
      {
        html: "<p>Hello &lt;b&gt; &amp; &quot;world&quot;</p>",
      },
      undefined,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves RTL base direction in the safe Rich HTML recovery", async () => {
    const sendMessage = vi.fn();
    const sendRichMessage = vi
      .fn()
      .mockRejectedValueOnce(badRequestError("Bad Request: RICH_BLOCK_INVALID"))
      .mockResolvedValueOnce({ message_id: 78 });

    await sendRenderedBotPart({
      api: { sendMessage, sendRichMessage },
      chatId: 100,
      part: { ...richPart, fallbackText: "سلام <test> دنیا" },
    });

    expect(sendRichMessage).toHaveBeenNthCalledWith(
      2,
      100,
      {
        html: "<p>سلام &lt;test&gt; دنیا</p>",
        is_rtl: true,
      },
      undefined,
    );
  });

  it("does not hide non-Bad-Request failures from the recovery attempt", async () => {
    const sendMessage = vi.fn();
    const rateLimit = Object.assign(new Error("Too Many Requests"), { error_code: 429 });
    const sendRichMessage = vi
      .fn()
      .mockRejectedValueOnce(badRequestError("Bad Request: RICH_BLOCK_INVALID"))
      .mockRejectedValueOnce(rateLimit);

    await expect(
      sendRenderedBotPart({
        api: { sendMessage, sendRichMessage },
        chatId: 100,
        part: richPart,
      }),
    ).rejects.toBe(rateLimit);

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

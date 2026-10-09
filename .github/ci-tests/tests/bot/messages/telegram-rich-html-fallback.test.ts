import { describe, expect, it, vi } from "vitest";
import { sendRenderedBotPart } from "../../../src/bot/messages/telegram-text.js";
import { renderTelegramMessageMarkdown } from "@opencode-telegram/native-runtime";
import type { TelegramRenderedPart } from "../../../src/bot/render/types.js";

function badRequestError(message: string): Error & { error_code: number } {
  return Object.assign(new Error(message), { error_code: 400 });
}
function part(source: string): TelegramRenderedPart {
  const rendered = renderTelegramMessageMarkdown(source)[0]!;
  return {
    blocks: [{ type: "paragraph", text: { type: "bold", text: rendered.text } }],
    fallbackText: rendered.text,
    entities: rendered.entities,
    source: "blocks",
  };
}

describe("bot/messages/canonical entity fallback", () => {
  it("recovers rejected native blocks with the Core entities without another Rich HTML parser", async () => {
    const rendered = part('**Hello** <script>x</script> & "world"');
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 77 });
    const sendRichMessage = vi
      .fn()
      .mockRejectedValue(badRequestError("Bad Request: RICH_BLOCK_INVALID"));
    await expect(
      sendRenderedBotPart({ api: { sendMessage, sendRichMessage }, chatId: 100, part: rendered }),
    ).resolves.toMatchObject({ messageId: 77 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(100, rendered.fallbackText, {
      entities: rendered.entities,
    });
    expect(rendered.fallbackText).toContain("<script>x</script>");
  });
  it("preserves Persian and ZWNJ in the normal-message recovery", async () => {
    const rendered = part("**سلام** می‌توانم <test> دنیا");
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 78 });
    const sendRichMessage = vi
      .fn()
      .mockRejectedValue(badRequestError("Bad Request: RICH_BLOCK_INVALID"));
    await sendRenderedBotPart({
      api: { sendMessage, sendRichMessage },
      chatId: 100,
      part: rendered,
    });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(100, "سلام می‌توانم <test> دنیا", {
      entities: rendered.entities,
    });
  });
  it("does not hide rate limits from the entity recovery attempt", async () => {
    const rateLimit = Object.assign(new Error("Too Many Requests"), { error_code: 429 });
    const sendMessage = vi.fn().mockRejectedValue(rateLimit);
    const sendRichMessage = vi
      .fn()
      .mockRejectedValue(badRequestError("Bad Request: RICH_BLOCK_INVALID"));
    await expect(
      sendRenderedBotPart({
        api: { sendMessage, sendRichMessage },
        chatId: 100,
        part: part("**Hello**"),
      }),
    ).rejects.toBe(rateLimit);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it("only falls back to plain text after an explicit entity parse rejection", async () => {
    const rendered = part("**Hello**");
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(badRequestError("Bad Request: can't parse entities"))
      .mockResolvedValueOnce({ message_id: 79 });
    const sendRichMessage = vi
      .fn()
      .mockRejectedValue(badRequestError("Bad Request: RICH_BLOCK_INVALID"));
    await sendRenderedBotPart({
      api: { sendMessage, sendRichMessage },
      chatId: 100,
      part: rendered,
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, 100, "Hello", undefined);
  });
  it("does not retry an unrelated rich delivery rejection", async () => {
    const failure = badRequestError("Bad Request: chat not found");
    const sendMessage = vi.fn();
    const sendRichMessage = vi.fn().mockRejectedValue(failure);
    await expect(
      sendRenderedBotPart({
        api: { sendMessage, sendRichMessage },
        chatId: 100,
        part: part("**Hello**"),
      }),
    ).rejects.toBe(failure);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

it("plain fallback drops caller entities after an entity parse rejection", async () => {
  const rendered = part("**Hello**");
  const sendMessage = vi
    .fn()
    .mockRejectedValueOnce(badRequestError("Bad Request: can't parse entities"))
    .mockResolvedValueOnce({ message_id: 80 });
  const sendRichMessage = vi
    .fn()
    .mockRejectedValue(badRequestError("Bad Request: RICH_BLOCK_INVALID"));
  await sendRenderedBotPart({
    api: { sendMessage, sendRichMessage },
    chatId: 100,
    part: rendered,
    options: { entities: [{ type: "bold", offset: 999, length: 50 }] },
  });
  expect(sendMessage).toHaveBeenNthCalledWith(2, 100, "Hello", {});
});

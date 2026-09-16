import { describe, expect, it, vi } from "vitest";
import {
  completeDraftPart,
  editRenderedBotPart,
  sendDraftBotPart,
  sendRenderedBotPart,
} from "../../../src/bot/messages/telegram-text.js";
import type { TelegramRenderedPart } from "../../../src/bot/render/types.js";

const persianPart: TelegramRenderedPart = {
  blocks: [
    {
      type: "paragraph",
      text: "🧭 S — داشبورد /session (PR #78) — State=busy و Tasks/Changes واقعی",
    },
  ],
  fallbackText: "🧭 S — داشبورد /session (PR #78) — State=busy و Tasks/Changes واقعی",
  source: "blocks",
};

const englishPart: TelegramRenderedPart = {
  blocks: [{ type: "paragraph", text: "State=busy and Tasks/Changes are available" }],
  fallbackText: "State=busy and Tasks/Changes are available",
  source: "blocks",
};

const codeOnlyPart: TelegramRenderedPart = {
  blocks: [
    { type: "pre", text: 'const msg = "سلام دنیا";', language: "javascript" },
  ],
  fallbackText: 'const msg = "سلام دنیا";',
  source: "blocks",
};

describe("bot/messages/telegram-text RTL transport", () => {
  it("sends mixed Persian rich messages with native RTL enabled", async () => {
    const sendMessage = vi.fn();
    const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 10 });

    await sendRenderedBotPart({
      api: { sendMessage, sendRichMessage },
      chatId: 100,
      part: persianPart,
    });

    expect(sendRichMessage).toHaveBeenCalledWith(
      100,
      { blocks: persianPart.blocks, is_rtl: true },
      undefined,
    );
  });

  it("does not force RTL for English rich messages", async () => {
    const sendMessage = vi.fn();
    const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 11 });

    await sendRenderedBotPart({
      api: { sendMessage, sendRichMessage },
      chatId: 100,
      part: englishPart,
    });

    expect(sendRichMessage).toHaveBeenCalledWith(
      100,
      { blocks: englishPart.blocks },
      undefined,
    );
  });

  it("preserves RTL while editing a streamed rich message", async () => {
    const editMessageText = vi.fn().mockResolvedValue(undefined);

    await editRenderedBotPart({
      api: { editMessageText },
      chatId: 100,
      messageId: 200,
      part: persianPart,
    });

    expect(editMessageText).toHaveBeenCalledWith(
      100,
      200,
      { blocks: persianPart.blocks, is_rtl: true },
      undefined,
    );
  });

  it("preserves RTL in native rich drafts", async () => {
    const sendMessageDraft = vi.fn();
    const sendRichMessageDraft = vi.fn().mockResolvedValue(true);

    await sendDraftBotPart({
      api: { sendMessageDraft, sendRichMessageDraft },
      chatId: 100,
      draftId: 7,
      part: persianPart,
    });

    expect(sendRichMessageDraft).toHaveBeenCalledWith(
      100,
      7,
      { blocks: persianPart.blocks, is_rtl: true },
      { can_stop: true, keep_on_stop: true },
    );
  });

  it("preserves RTL when a draft is finalized into a persistent message", async () => {
    const sendMessage = vi.fn();
    const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 12 });
    const deleteMessage = vi.fn().mockResolvedValue(true);

    await completeDraftPart({
      api: { sendMessage, sendRichMessage, deleteMessage },
      chatId: 100,
      part: persianPart,
    });

    expect(sendRichMessage).toHaveBeenCalledWith(
      100,
      { blocks: persianPart.blocks, is_rtl: true },
      undefined,
    );
  });

  it("does not force RTL on code-only parts containing Persian string literals", async () => {
    const sendMessage = vi.fn();
    const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 13 });

    await sendRenderedBotPart({
      api: { sendMessage, sendRichMessage },
      chatId: 100,
      part: codeOnlyPart,
    });

    expect(sendRichMessage).toHaveBeenCalledWith(
      100,
      { blocks: codeOnlyPart.blocks },
      undefined,
    );
  });
});

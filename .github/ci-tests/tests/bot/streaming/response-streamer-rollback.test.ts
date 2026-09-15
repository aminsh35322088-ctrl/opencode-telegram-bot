import { describe, expect, it, vi } from "vitest";
import { ResponseStreamer } from "../../../src/bot/streaming/response-streamer.js";
import { getTelegramRenderedPartSignature } from "../../../src/bot/render/part-signature.js";
import type { TelegramRenderedPart } from "../../../src/bot/render/types.js";

function plainPart(text: string): TelegramRenderedPart {
  return {
    blocks: [],
    fallbackText: text,
    source: "plain",
  };
}

function signature(part: TelegramRenderedPart): string {
  return getTelegramRenderedPartSignature(part);
}

describe("bot/streaming/response-streamer persisted-part rollback", () => {
  it("rolls back already persisted final parts when a later part fails", async () => {
    let nextStreamMessageId = 1;
    const sendPart = vi.fn(async (part: TelegramRenderedPart) => ({
      messageId: nextStreamMessageId++,
      deliveredSignature: signature(part),
    }));
    const editPart = vi.fn(async (_messageId: number, part: TelegramRenderedPart) => ({
      deliveredSignature: signature(part),
    }));
    const deleteText = vi.fn().mockResolvedValue(undefined);
    const rollbackFirstPersistedPart = vi.fn().mockResolvedValue(undefined);
    const completePart = vi
      .fn()
      .mockImplementationOnce(async (part: TelegramRenderedPart) => ({
        messageId: 900,
        deliveredSignature: signature(part),
        rollback: rollbackFirstPersistedPart,
      }))
      .mockRejectedValueOnce(new Error("Telegram persistence failed"));

    const streamer = new ResponseStreamer({
      throttleMs: 0,
      sendPart,
      editPart,
      deleteText,
      completePart,
    });

    const payload = { parts: [plainPart("first"), plainPart("second")] };
    streamer.enqueue("session-1", "message-1", payload);

    await vi.waitFor(() => {
      expect(sendPart).toHaveBeenCalledTimes(2);
    });

    const result = await streamer.complete("session-1", "message-1", payload);

    expect(result).toEqual({ streamed: false, telegramMessageIds: [] });
    expect(completePart).toHaveBeenCalledTimes(2);
    expect(rollbackFirstPersistedPart).toHaveBeenCalledTimes(1);
    expect(deleteText).toHaveBeenCalledTimes(2);
    expect(deleteText).toHaveBeenNthCalledWith(1, 2);
    expect(deleteText).toHaveBeenNthCalledWith(2, 1);
  });
});

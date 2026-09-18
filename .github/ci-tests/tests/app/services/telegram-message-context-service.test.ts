import { describe, expect, it } from "vitest";
import type { Context } from "grammy";
import { buildTelegramMessageSnapshot } from "../../../src/app/services/telegram-message-context-service.js";

describe("telegram message context snapshot", () => {
  it("captures current, reply, forward and media metadata without Telegram credentials", () => {
    const ctx = {
      message: {
        message_id: 44,
        date: 1234,
        caption: "forwarded photo",
        photo: [{ file_id: "small", file_size: 12 }, { file_id: "large", file_size: 42 }],
        forward_origin: { type: "user", date: 1200, sender_user: { id: 9, first_name: "Alice", username: "alice" } },
        reply_to_message: { message_id: 43, date: 1201, text: "listen", voice: { file_id: "voice-id", mime_type: "audio/ogg", file_size: 99 } },
      },
    } as unknown as Context;
    const snapshot = buildTelegramMessageSnapshot(ctx)!;
    expect(snapshot.messageId).toBe(44);
    expect(snapshot.media).toEqual([{ kind: "photo", fileId: "large", fileSize: 42 }]);
    expect(snapshot.forward).toMatchObject({ type: "user", sender: { id: 9, firstName: "Alice", username: "alice" } });
    expect(snapshot.reply?.media).toEqual([{ kind: "voice", fileId: "voice-id", mimeType: "audio/ogg", fileSize: 99 }]);
  });
});
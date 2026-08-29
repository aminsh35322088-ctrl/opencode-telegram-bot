import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlineKeyboard } from "grammy";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu, replyWithInlineMenu } from "../../../src/bot/menus/inline-menu.js";

describe("inline-menu", () => {
  beforeEach(() => interactionManager.clear("test_setup"));

  it("adds a cancel button without creating empty rows", () => {
    const keyboard = new InlineKeyboard().text("Session A", "session:1").row();
    appendInlineMenuCancelButton(keyboard, "session");
    expect(keyboard.inline_keyboard.some((row) => row.length === 0)).toBe(false);
    expect(keyboard.inline_keyboard.at(-1)?.[0]?.callback_data).toBe("inline:cancel:session");
  });

  it("registers an active inline interaction", async () => {
    const ctx = {
      chat: { id: 100 },
      reply: vi.fn().mockResolvedValue({ message_id: 42 }),
    } as never;
    await replyWithInlineMenu(ctx, { menuKind: "session", text: "Select session", keyboard: new InlineKeyboard().text("A", "session:a") });
    expect(interactionManager.getSnapshot()?.kind).toBe("inline");
    expect(interactionManager.getSnapshot()?.metadata.menuKind).toBe("session");
  });

  it("accepts the active matching menu", async () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { menuKind: "session", messageId: 42 } });
    const ctx = { callbackQuery: { data: "session:a", message: { message_id: 42 } } } as never;
    await expect(ensureActiveInlineMenu(ctx, "session")).resolves.toBe(true);
  });
});

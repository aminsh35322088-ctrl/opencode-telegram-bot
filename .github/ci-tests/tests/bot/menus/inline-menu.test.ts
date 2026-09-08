import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlineKeyboard } from "grammy";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu, replyWithInlineMenu } from "../../../src/bot/menus/inline-menu.js";

function getCallbackData(button: unknown): string | undefined {
  if (!button || typeof button !== "object" || !("callback_data" in button)) return undefined;
  const value = (button as { callback_data?: unknown }).callback_data;
  return typeof value === "string" ? value : undefined;
}

function getButtonText(button: unknown): string | undefined {
  if (!button || typeof button !== "object" || !("text" in button)) return undefined;
  const value = (button as { text?: unknown }).text;
  return typeof value === "string" ? value : undefined;
}

describe("inline-menu", () => {
  beforeEach(() => interactionManager.clear("test_setup"));

  it("adds a cancel button without creating empty rows", () => {
    const keyboard = new InlineKeyboard().text("Session A", "session:1").row();
    appendInlineMenuCancelButton(keyboard, "session");
    expect(keyboard.inline_keyboard.some((row) => row.length === 0)).toBe(false);
    expect(getCallbackData(keyboard.inline_keyboard.at(-1)?.[0])).toBe("inline:cancel:session");
  });

  it("uses Close instead of Home for Topic Settings", () => {
    const keyboard = new InlineKeyboard().text("Option", "settings:appearance").row();
    appendInlineMenuCancelButton(keyboard, "settings", 735542);
    const last = keyboard.inline_keyboard.at(-1)?.[0];
    expect(getButtonText(last)).toBe("✖ Close");
    expect(getCallbackData(last)).toBe("inline:cancel:settings");
    expect(keyboard.inline_keyboard.some((row) => row.some((button) => button.text === "🏠 Home"))).toBe(false);
  });

  it("uses Back for Topic Settings child menus", () => {
    const keyboard = new InlineKeyboard().text("Agent A", "agent:a").row();
    appendInlineMenuCancelButton(keyboard, "agent", 735542);
    const last = keyboard.inline_keyboard.at(-1)?.[0];
    expect(getButtonText(last)).toBe("← Back");
    expect(getCallbackData(last)).toBe("settings:back");
  });

  it("keeps Home for non-Topic menus", () => {
    const keyboard = new InlineKeyboard().text("Option", "settings:appearance").row();
    appendInlineMenuCancelButton(keyboard, "settings");
    const last = keyboard.inline_keyboard.at(-1)?.[0];
    expect(getButtonText(last)).toBe("🏠 Home");
    expect(getCallbackData(last)).toBe("main:home");
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
    const ctx = {
      chat: { id: 100 },
      callbackQuery: { data: "session:a", message: { message_id: 42 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    } as never;
    await expect(ensureActiveInlineMenu(ctx, "session")).resolves.toBe(true);
  });
});

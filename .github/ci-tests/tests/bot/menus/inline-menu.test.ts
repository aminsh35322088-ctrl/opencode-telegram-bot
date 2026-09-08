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

function allButtons(keyboard: InlineKeyboard): unknown[] {
  return keyboard.inline_keyboard.flat() as unknown[];
}

describe("inline-menu", () => {
  beforeEach(() => interactionManager.clear("test_setup"));

  it("adds a cancel button without creating empty rows", () => {
    const keyboard = new InlineKeyboard().text("Session A", "session:1").row();
    appendInlineMenuCancelButton(keyboard, "session");
    expect(keyboard.inline_keyboard.some((row) => row.length === 0)).toBe(false);
    expect(getCallbackData(keyboard.inline_keyboard.at(-1)?.[0])).toBe("inline:cancel:session");
  });

  it("uses Close instead of Home for Topic Settings root", () => {
    const keyboard = new InlineKeyboard().text("Option", "settings:appearance").row();
    appendInlineMenuCancelButton(keyboard, "settings", 735542);
    const last = keyboard.inline_keyboard.at(-1)?.[0];
    expect(getButtonText(last)).toBe("✖ Close");
    expect(getCallbackData(last)).toBe("inline:cancel:settings");
    expect(allButtons(keyboard).some((button) => getButtonText(button) === "🏠 Home")).toBe(false);
  });

  it("uses Back for Topic Settings child screens", () => {
    const keyboard = new InlineKeyboard().text("← Settings", "settings:back");
    appendInlineMenuCancelButton(keyboard, "settings", 735542, "back");
    const last = keyboard.inline_keyboard.at(-1)?.[0];
    expect(getButtonText(last)).toBe("← Back");
    expect(getCallbackData(last)).toBe("settings:back");
  });

  it("adds Back to Topic Model Center screens that have no existing navigation", () => {
    const keyboard = new InlineKeyboard().text("🧠 Model", "mc:select:test");
    appendInlineMenuCancelButton(keyboard, "model", 735542);
    const last = keyboard.inline_keyboard.at(-1)?.[0];
    expect(getButtonText(last)).toBe("← Back");
    expect(getCallbackData(last)).toBe("settings:back");
  });

  it("does not duplicate existing Model Center Back navigation", () => {
    const keyboard = new InlineKeyboard().text("← Back", "mc:settings_back");
    appendInlineMenuCancelButton(keyboard, "model", 735542);
    expect(allButtons(keyboard).filter((button) => getButtonText(button) === "← Back")).toHaveLength(1);
    expect(getCallbackData(keyboard.inline_keyboard.at(-1)?.[0])).toBe("mc:settings_back");
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

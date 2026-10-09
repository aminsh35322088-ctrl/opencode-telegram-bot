import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlineKeyboard } from "grammy";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { appendInlineMenuCancelButton, clearActiveInlineMenu, ensureActiveInlineMenu, replyWithInlineMenu } from "../../../src/bot/menus/inline-menu.js";

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
  beforeEach(() => { interactionManager.clear("test_setup"); clearActiveInlineMenu("test_setup"); });

  it("adds a Home button without creating empty rows in non-topic chats", () => {
    const keyboard = new InlineKeyboard().text("Session A", "session:1").row();
    appendInlineMenuCancelButton(keyboard, "session");
    expect(keyboard.inline_keyboard.some((row) => row.length === 0)).toBe(false);
    expect(getCallbackData(keyboard.inline_keyboard.at(-1)?.[0])).toBe("main:home");
  });

  it("uses Close instead of Home for Topic Settings root", () => {
    const keyboard = new InlineKeyboard().text("Option", "settings:appearance").row();
    appendInlineMenuCancelButton(keyboard, "settings", 735542);
    const last = keyboard.inline_keyboard.at(-1)?.[0];
    expect(getButtonText(last)).toBe("✖ Close");
    expect(getCallbackData(last)).toBe("inline:cancel:settings");
    expect(allButtons(keyboard).some((button) => getButtonText(button) === "🏠 Home")).toBe(false);
  });

  it("uses Back and Close without Home for Topic Settings child screens", () => {
    const keyboard = new InlineKeyboard().text("← Settings", "settings:back");
    appendInlineMenuCancelButton(keyboard, "settings", 735542, "back");
    const buttons = allButtons(keyboard);
    expect(buttons.filter((button) => getButtonText(button) === "← Back")).toHaveLength(1);
    expect(buttons.filter((button) => getButtonText(button) === "✖ Close")).toHaveLength(1);
    expect(buttons.some((button) => getButtonText(button) === "🏠 Home")).toBe(false);
  });

  it("adds Back and Close to Topic Model Center screens that have no existing navigation", () => {
    const keyboard = new InlineKeyboard().text("🧠 Model", "mc:select:test");
    appendInlineMenuCancelButton(keyboard, "model", 735542);
    const buttons = allButtons(keyboard);
    expect(buttons.some((button) => getButtonText(button) === "← Back" && getCallbackData(button) === "settings:back")).toBe(true);
    expect(buttons.some((button) => getButtonText(button) === "✖ Close")).toBe(true);
    expect(buttons.some((button) => getButtonText(button) === "🏠 Home")).toBe(false);
  });

  it("keeps one Model Center Back, adds Close, and never injects Home in a Topic", () => {
    const keyboard = new InlineKeyboard().text("← Back", "mc:settings_back");
    appendInlineMenuCancelButton(keyboard, "model", 735542, "both");
    const buttons = allButtons(keyboard);
    expect(buttons.filter((button) => getButtonText(button) === "← Back")).toHaveLength(1);
    expect(buttons.filter((button) => getButtonText(button) === "✖ Close")).toHaveLength(1);
    expect(buttons.some((button) => getButtonText(button) === "🏠 Home")).toBe(false);
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

  it("retires the previous Topic panel before opening a newly invoked menu", async () => {
    const reply = vi.fn()
      .mockResolvedValueOnce({ message_id: 42 })
      .mockResolvedValueOnce({ message_id: 43 });
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const ctx = {
      chat: { id: 100 },
      message: { message_id: 10, message_thread_id: 735542 },
      reply,
      api: { editMessageText, deleteMessage },
    } as never;

    await replyWithInlineMenu(ctx, {
      menuKind: "settings",
      text: "Topic Settings",
      keyboard: new InlineKeyboard().text("Option", "settings:appearance"),
    });
    await replyWithInlineMenu(ctx, {
      menuKind: "model",
      text: "Model Center",
      keyboard: new InlineKeyboard().text("Provider", "mc:providers"),
    });

    expect(deleteMessage).toHaveBeenCalledWith(100, 42);
    expect(editMessageText).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(2);
    expect(interactionManager.getSnapshot()?.metadata.messageId).toBe(43);
    expect(interactionManager.getSnapshot()?.metadata.menuKind).toBe("model");
  });

  it("never falls back to a new message when callback navigation cannot edit its panel", async () => {
    const reply = vi.fn().mockResolvedValue({ message_id: 99 });
    const editMessageText = vi.fn().mockRejectedValue(new Error("message can't be edited"));
    const ctx = {
      chat: { id: 100 },
      callbackQuery: {
        data: "mc:providers",
        message: { message_id: 42, message_thread_id: 735542 },
      },
      reply,
      api: { editMessageText },
    } as never;

    await expect(replyWithInlineMenu(ctx, {
      menuKind: "model",
      text: "Providers",
      keyboard: new InlineKeyboard().text("Provider", "mc:provider:p:0"),
    })).rejects.toThrow("message can't be edited");
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not create a duplicate when callback navigation reports message is not modified", async () => {
    const reply = vi.fn();
    const editMessageText = vi.fn().mockRejectedValue(new Error("Bad Request: message is not modified"));
    const ctx = {
      chat: { id: 100 },
      callbackQuery: {
        data: "settings:appearance",
        message: { message_id: 77, message_thread_id: 735543 },
      },
      reply,
      api: { editMessageText },
    } as never;

    const messageId = await replyWithInlineMenu(ctx, {
      menuKind: "settings",
      text: "Topic Settings",
      keyboard: new InlineKeyboard().text("Option", "settings:appearance"),
    });

    expect(messageId).toBe(77);
    expect(reply).not.toHaveBeenCalled();
    expect(interactionManager.getSnapshot()?.metadata.messageId).toBe(77);
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

  it("refreshes the interaction TTL while the menu is actively used", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { menuKind: "session", messageId: 42 } });
      vi.setSystemTime(start + 14 * 60 * 1000);
      const ctx = {
        chat: { id: 100 },
        callbackQuery: { data: "session:a", message: { message_id: 42 } },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      } as never;
      await expect(ensureActiveInlineMenu(ctx, "session")).resolves.toBe(true);
      vi.setSystemTime(start + 20 * 60 * 1000);
      expect(interactionManager.isExpired()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

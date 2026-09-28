import { describe, expect, it, vi } from "vitest";

const getMainNavigationMessageId = vi.hoisted(() => vi.fn());
vi.mock("../../../src/app/stores/settings-store.js", () => ({ getMainNavigationMessageId }));

const {
  callbackMessageId,
  escapeHtml,
} = await import("../../../src/bot/commands/panel-render.js");

/**
 * `callbackMessageId` had four near-identical copies across command modules and
 * they had drifted: only one validated that a stored Main-panel id is a usable
 * Telegram message id. These cases pin the consolidated behaviour.
 */
describe("callbackMessageId", () => {
  const withPanel = (canonical: unknown) => ({
    chat: { id: 42 },
    callbackQuery: { message: { message_id: 999, chat: { id: 42 } } },
    __canonical: canonical,
  });

  it("prefers the message the callback arrived on when no panel is pinned", () => {
    const ctx = { chat: { id: 42 }, callbackQuery: { message: { message_id: 999, chat: { id: 42 } } } };
    expect(callbackMessageId(ctx as never)).toBe(999);
  });

  it("returns null when there is no usable message", () => {
    expect(callbackMessageId({ chat: { id: 42 } } as never)).toBeNull();
    expect(callbackMessageId({} as never)).toBeNull();
  });

  it("falls back to the callback message when the ctx has no chat", () => {
    const ctx = { callbackQuery: { message: { message_id: 7, chat: { id: 42 } } } };
    expect(callbackMessageId(ctx as never)).toBe(7);
  });

  it("prefers a valid pinned Main panel over the callback message", () => {
    getMainNavigationMessageId.mockReturnValue(1234);
    const ctx = { chat: { id: 42 }, callbackQuery: { message: { message_id: 999, chat: { id: 42 } } } };
    expect(callbackMessageId(ctx as never)).toBe(1234);
    expect(getMainNavigationMessageId).toHaveBeenCalledWith(42);
  });

  it("rejects a corrupt panel id and falls back to the callback message", () => {
    const ctx = { chat: { id: 42 }, callbackQuery: { message: { message_id: 999, chat: { id: 42 } } } };
    for (const bad of [0, -1, 1.5, Number.NaN, undefined, "1234"]) {
      getMainNavigationMessageId.mockReturnValue(bad);
      expect(callbackMessageId(ctx as never)).toBe(999);
    }
  });
});

describe("escapeHtml", () => {
  it("escapes the three characters that break Telegram HTML parse mode", () => {
    expect(escapeHtml('a & b < c > d')).toBe("a &amp; b &lt; c &gt; d");
  });

  it("escapes ampersands before the entities it introduces", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves quotes untouched, matching the text-body contract", () => {
    expect(escapeHtml('say "hi"')).toBe('say "hi"');
  });

  it("is idempotent-safe for already-plain text", () => {
    expect(escapeHtml("plain-text_123")).toBe("plain-text_123");
  });
});

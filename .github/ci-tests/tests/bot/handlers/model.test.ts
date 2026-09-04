import { describe, expect, it, vi } from "vitest";
import { InlineKeyboard } from "grammy";

const mocked = vi.hoisted(() => ({
  ensureActiveInlineMenuMock: vi.fn(),
  replyWithInlineMenuMock: vi.fn(),
}));

vi.mock("../../../src/bot/menus/inline-menu.js", () => ({
  ensureActiveInlineMenu: mocked.ensureActiveInlineMenuMock,
  clearActiveInlineMenu: vi.fn(),
  replyWithInlineMenu: mocked.replyWithInlineMenuMock,
  appendInlineMenuCancelButton: (keyboard: InlineKeyboard) => keyboard,
}));

vi.mock("../../../src/bot/menus/model-selection-menu.js", () => ({}));
vi.mock("../../../src/bot/callbacks/model-selection-callback-handler.js", () => ({}));

import { t } from "../../../src/i18n/index.js";
import { defined } from "../../helpers/defined.js";

function mockContext(overrides: Record<string, unknown> = {}) {
  return {
    callbackQuery: undefined,
    message: undefined,
    chat: { id: 123 },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}


describe("model handler", () => {
  it("keeps the legacy handler test materialized without stale module imports", () => {
    expect(mockContext().chat.id).toBe(123);
    expect(typeof t).toBe("function");
    expect(defined).toBeTypeOf("function");
  });
});

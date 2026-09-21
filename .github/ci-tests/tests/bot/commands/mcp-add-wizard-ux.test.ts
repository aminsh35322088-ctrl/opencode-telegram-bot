import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSessionDirectory: vi.fn(() => "/work/repo"),
}));

vi.mock("../../../src/app/services/mcp-catalog-service.js", () => ({
  addMcpCatalogServer: vi.fn(),
  loadMcpCatalog: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getMainNavigationMessageId: () => 4242,
}));

import {
  clearMcpAddWizard,
  dismissMcpAddWizard,
  startMcpAddWizard,
} from "../../../src/bot/commands/mcp-catalog-command.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";

function createContext(): Context {
  return {
    chat: { id: 777 },
    callbackQuery: {
      data: "mcps:add",
      message: { message_id: 500, chat: { id: 777 } },
    } as Context["callbackQuery"],
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ message_id: 901 }),
    api: {
      deleteMessage: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Context;
}

describe("MCP add wizard UX", () => {
  afterEach(() => {
    clearMcpAddWizard();
    interactionManager.clear("test_cleanup");
  });

  it("edits the existing General panel instead of sending a temporary wizard message", async () => {
    const ctx = createContext();

    await startMcpAddWizard(ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.api.editMessageText).toHaveBeenCalledWith(
      777,
      4242,
      expect.stringContaining("1/3 · Server name"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    const state = interactionManager.getSnapshot();
    expect(state?.expectedInput).toBe("mixed");
    expect(state?.metadata.stage).toBe("add");
    expect(state?.metadata.messageId).toBe(4242);
    expect(state?.metadata.parentMessageId).toBeUndefined();
  });

  it("dismisses without deleting the General panel", async () => {
    const ctx = createContext();
    await startMcpAddWizard(ctx);
    (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mockClear();

    const dismissed = await dismissMcpAddWizard(ctx);

    expect(dismissed).toBe(true);
    expect(ctx.api.deleteMessage).not.toHaveBeenCalled();
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();
    expect(interactionManager.getSnapshot()).toBeNull();
  });
});

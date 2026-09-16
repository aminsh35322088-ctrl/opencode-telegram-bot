import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSessionDirectory: vi.fn(() => "/work/repo"),
}));

vi.mock("../../../src/app/services/mcp-catalog-service.js", () => ({
  addMcpCatalogServer: vi.fn(),
  loadMcpCatalog: vi.fn().mockResolvedValue([]),
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

  it("opens the wizard in a separate temporary message without editing the parent menu", async () => {
    const ctx = createContext();

    await startMcpAddWizard(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("1/3 · Server name"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();

    const state = interactionManager.getSnapshot();
    expect(state?.metadata.stage).toBe("add");
    expect(state?.metadata.messageId).toBe(901);
    expect(state?.metadata.parentMessageId).toBe(500);
  });

  it("dismisses only the temporary wizard message when parent restore is not requested", async () => {
    const ctx = createContext();
    await startMcpAddWizard(ctx);

    const dismissed = await dismissMcpAddWizard(ctx);

    expect(dismissed).toBe(true);
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(777, 901);
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();
    expect(interactionManager.getSnapshot()).toBeNull();
  });
});

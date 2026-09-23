import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSessionDirectory: vi.fn(() => "/work/repo"),
}));

const mockedMcp = vi.hoisted(() => ({
  startMcpOAuth: vi.fn().mockResolvedValue({
    authorizationUrl: "https://login.example/authorize?state=oauth-state",
    oauthState: "oauth-state",
  }),
  completeMcpOAuth: vi.fn().mockResolvedValue({
    name: "sentry",
    status: { status: "connected" },
  }),
}));

vi.mock("../../../src/app/services/mcp-catalog-service.js", () => ({
  addMcpCatalogServer: vi.fn(),
  loadMcpCatalog: vi.fn().mockResolvedValue([]),
  startMcpOAuth: mockedMcp.startMcpOAuth,
  completeMcpOAuth: mockedMcp.completeMcpOAuth,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getMainNavigationMessageId: () => 4242,
}));

import {
  clearMcpAddWizard,
  clearMcpAuthWizard,
  dismissMcpAddWizard,
  handleMcpsMessage,
  startMcpAddWizard,
  startMcpAuthWizard,
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

function createTextContext(text: string): Context {
  return {
    chat: { id: 777 },
    message: { message_id: 600, text, chat: { id: 777 } },
    api: {
      deleteMessage: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Context;
}

describe("MCP add wizard UX", () => {
  afterEach(() => {
    clearMcpAddWizard();
    clearMcpAuthWizard();
    mockedMcp.startMcpOAuth.mockClear();
    mockedMcp.completeMcpOAuth.mockClear();
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

  it("starts OAuth in the existing panel and never asks the model for credentials", async () => {
    const ctx = createContext();
    await startMcpAuthWizard(ctx, {
      serverName: "sentry",
      projectDirectory: "/work/repo",
      messageId: 4242,
    });

    expect(mockedMcp.startMcpOAuth).toHaveBeenCalledWith("/work/repo", "sentry");
    expect(ctx.api.editMessageText).toHaveBeenCalledWith(
      777,
      4242,
      expect.stringContaining("The authorization code is deleted from Telegram immediately"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("auth");
    expect(interactionManager.getSnapshot()?.expectedInput).toBe("mixed");
  });

  it("rejects an OAuth callback with the wrong state", async () => {
    const startCtx = createContext();
    await startMcpAuthWizard(startCtx, {
      serverName: "sentry",
      projectDirectory: "/work/repo",
      messageId: 4242,
    });

    const ctx = createTextContext("http://127.0.0.1/callback?code=secret-code&state=wrong-state");
    expect(await handleMcpsMessage(ctx)).toBe(true);
    expect(mockedMcp.completeMcpOAuth).not.toHaveBeenCalled();
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("auth");
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(777, 600);
  });

  it("completes OAuth only after matching state and deletes the callback message", async () => {
    const startCtx = createContext();
    await startMcpAuthWizard(startCtx, {
      serverName: "sentry",
      projectDirectory: "/work/repo",
      messageId: 4242,
    });

    const ctx = createTextContext("http://127.0.0.1/callback?code=secret-code&state=oauth-state");
    expect(await handleMcpsMessage(ctx)).toBe(true);
    expect(mockedMcp.completeMcpOAuth).toHaveBeenCalledWith("/work/repo", "sentry", "secret-code");
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(777, 600);
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("list");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocked = vi.hoisted(() => ({
  loadMcpCatalog: vi.fn(),
  parseMcpCatalogServers: vi.fn((value: unknown) => value),
  toggleMcpCatalogServer: vi.fn(),
  startMcpOAuth: vi.fn(),
  completeMcpOAuth: vi.fn(),
  resolveMcpRemoteUrl: vi.fn(),
  getMcpAuthSummary: vi.fn(),
  configureSecureMcpAuth: vi.fn(),
  resetMcpAuthToAuto: vi.fn(),
  currentSessionDirectory: "/work/repo" as string | null,
}));

vi.mock("../../../src/app/services/mcp-catalog-service.js", () => ({
  loadMcpCatalog: mocked.loadMcpCatalog,
  parseMcpCatalogServers: mocked.parseMcpCatalogServers,
  toggleMcpCatalogServer: mocked.toggleMcpCatalogServer,
  startMcpOAuth: mocked.startMcpOAuth,
  completeMcpOAuth: mocked.completeMcpOAuth,
  resolveMcpRemoteUrl: mocked.resolveMcpRemoteUrl,
  getMcpAuthSummary: mocked.getMcpAuthSummary,
  configureSecureMcpAuth: mocked.configureSecureMcpAuth,
  resetMcpAuthToAuto: mocked.resetMcpAuthToAuto,
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSessionDirectory: vi.fn(() => mocked.currentSessionDirectory),
}));

import { handleMcpsCallback } from "../../../src/bot/callbacks/mcp-catalog-callback-handler.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";

function createCallbackContext(data: string, messageId: number): Context {
  return {
    chat: { id: 777 },
    callbackQuery: {
      data,
      message: { message_id: messageId, chat: { id: 777 } },
    } as Context["callbackQuery"],
    reply: vi.fn().mockResolvedValue({ message_id: 901 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

function answerTexts(ctx: Context): string[] {
  return (ctx.answerCallbackQuery as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => String((call[0] as { text?: string } | undefined)?.text ?? ""),
  );
}

describe("mcp catalog callback recovery", () => {
  beforeEach(() => {
    interactionManager.clear("test_setup");
    mocked.loadMcpCatalog.mockReset();
    mocked.resolveMcpRemoteUrl.mockReset();
    mocked.resolveMcpRemoteUrl.mockResolvedValue("https://mcp.example.com/mcp");
    mocked.getMcpAuthSummary.mockReset();
    mocked.getMcpAuthSummary.mockResolvedValue(null);
    mocked.configureSecureMcpAuth.mockReset();
    mocked.resetMcpAuthToAuto.mockReset();
    mocked.currentSessionDirectory = "/work/repo";
  });

  it("self-heals a clobbered interaction by re-rendering the server list", async () => {
    const servers = [{ name: "context7", status: { status: "connected" } }];
    mocked.loadMcpCatalog.mockResolvedValue(servers);
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      metadata: { menuKind: "settings", messageId: 555 },
    });

    const ctx = createCallbackContext("mcps:select:0", 777);
    const handled = await handleMcpsCallback(ctx);

    expect(handled).toBe(true);
    expect(answerTexts(ctx).some((text) => text.includes("inactive"))).toBe(false);
    expect((ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);

    const snapshot = interactionManager.getSnapshot();
    expect(snapshot?.kind).toBe("custom");
    expect(snapshot?.metadata.flow).toBe("mcps");
    expect(snapshot?.metadata.messageId).toBe(777);
  });

  it("falls back to the inactive alert when recovery cannot load the catalog", async () => {
    mocked.loadMcpCatalog.mockRejectedValue(new Error("server gone"));

    const ctx = createCallbackContext("mcps:select:0", 777);
    const handled = await handleMcpsCallback(ctx);

    expect(handled).toBe(true);
    expect(answerTexts(ctx).some((text) => text.includes("inactive"))).toBe(true);
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it("keeps a valid list interaction working without recovery", async () => {
    const servers = [{ name: "context7", status: { status: "connected" } }];
    mocked.loadMcpCatalog.mockResolvedValue(servers);
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: { flow: "mcps", stage: "list", messageId: 777, projectDirectory: "/work/repo", servers },
    });

    const ctx = createCallbackContext("mcps:select:0", 777);
    const handled = await handleMcpsCallback(ctx);

    expect(handled).toBe(true);
    expect(answerTexts(ctx).some((text) => text.includes("inactive"))).toBe(false);
    expect(mocked.loadMcpCatalog).not.toHaveBeenCalled();
  });
  it("opens the auth-method menu in the same MCP detail panel", async () => {
    const servers = [{ name: "secure", status: { status: "failed", error: "Unauthorized" } }];
    mocked.loadMcpCatalog.mockResolvedValue(servers);
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "mcps",
        stage: "detail",
        messageId: 777,
        projectDirectory: "/work/repo",
        serverName: "secure",
        servers,
      },
    });

    const ctx = createCallbackContext("mcps:auth:options", 777);
    expect(await handleMcpsCallback(ctx)).toBe(true);

    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.api.editMessageText).toHaveBeenCalledWith(
      777,
      777,
      expect.stringContaining("Authentication · secure"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("auth_setup");
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("menu");
  });

  it("starts OAuth client setup directly for needs_client_registration", async () => {
    const servers = [{
      name: "enterprise",
      status: { status: "needs_client_registration", error: "Client registration required" },
    }];
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "mcps",
        stage: "detail",
        messageId: 777,
        projectDirectory: "/work/repo",
        serverName: "enterprise",
        servers,
      },
    });

    const ctx = createCallbackContext("mcps:auth:client", 777);
    expect(await handleMcpsCallback(ctx)).toBe(true);

    expect(ctx.api.editMessageText).toHaveBeenCalledWith(
      777,
      777,
      expect.stringContaining("OAuth Client ID"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("auth_setup");
    expect(interactionManager.getSnapshot()?.metadata.mode).toBe("oauth-client");
    expect(interactionManager.getSnapshot()?.expectedInput).toBe("mixed");
  });

  it("cancels credential setup back to the same server detail instead of creating a message", async () => {
    const servers = [{ name: "secure", status: { status: "failed", error: "Unauthorized" } }];
    mocked.loadMcpCatalog.mockResolvedValue(servers);
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "mcps",
        stage: "detail",
        messageId: 777,
        projectDirectory: "/work/repo",
        serverName: "secure",
        servers,
      },
    });

    const openCtx = createCallbackContext("mcps:auth:options", 777);
    await handleMcpsCallback(openCtx);

    const cancelCtx = createCallbackContext("mcps:auth:cancel", 777);
    expect(await handleMcpsCallback(cancelCtx)).toBe(true);

    expect(cancelCtx.reply).not.toHaveBeenCalled();
    expect(cancelCtx.api.editMessageText).toHaveBeenCalledWith(
      777,
      777,
      expect.stringContaining("secure"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("detail");
  });

});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSessionDirectory: vi.fn(() => "/work/repo"),
}));

const mockedMcp = vi.hoisted(() => ({
  createMcpServerFromInput: vi.fn(),
  loadMcpServers: vi.fn(),
  startMcpOAuth: vi.fn().mockResolvedValue({
    authorizationUrl: "https://login.example/authorize?state=oauth-state",
    oauthState: "oauth-state",
  }),
  completeMcpOAuth: vi.fn().mockResolvedValue({
    name: "sentry",
    status: { status: "connected" },
  }),
  resolveMcpRemoteUrl: vi.fn(),
  configureSecureMcpAuth: vi.fn(),
  getMcpAuthSummary: vi.fn(),
  resetMcpAuthToAuto: vi.fn(),
}));

vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  createMcpServerFromInput: mockedMcp.createMcpServerFromInput,
  loadMcpServers: mockedMcp.loadMcpServers,
  startMcpOAuth: mockedMcp.startMcpOAuth,
  completeMcpOAuth: mockedMcp.completeMcpOAuth,
  resolveMcpRemoteUrl: mockedMcp.resolveMcpRemoteUrl,
  configureSecureMcpAuth: mockedMcp.configureSecureMcpAuth,
  getMcpAuthSummary: mockedMcp.getMcpAuthSummary,
  resetMcpAuthToAuto: mockedMcp.resetMcpAuthToAuto,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getMainNavigationMessageId: () => 4242,
}));

import {
  backMcpAddWizard,
  backMcpCredentialWizard,
  clearMcpAddWizard,
  clearMcpAuthWizard,
  clearMcpCredentialWizard,
  dismissMcpAddWizard,
  handleMcpsMessage,
  selectMcpCredentialMode,
  skipMcpCredentialOptionalStep,
  selectMcpAddType,
  startMcpAddWizard,
  startMcpAuthWizard,
  startMcpCredentialWizard,
} from "../../../src/bot/commands/mcp-server-command.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { t } from "../../../src/i18n/index.js";

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
  beforeEach(() => {
    mockedMcp.createMcpServerFromInput.mockResolvedValue(undefined);
    mockedMcp.loadMcpServers.mockResolvedValue([]);
    mockedMcp.startMcpOAuth.mockResolvedValue({
      authorizationUrl: "https://login.example/authorize?state=oauth-state",
      oauthState: "oauth-state",
    });
    mockedMcp.completeMcpOAuth.mockResolvedValue({
      name: "sentry",
      status: { status: "connected" },
    });
    mockedMcp.resolveMcpRemoteUrl.mockResolvedValue("https://mcp.example.com/mcp");
    mockedMcp.configureSecureMcpAuth.mockResolvedValue({
      name: "secure",
      status: { status: "connected" },
    });
    mockedMcp.getMcpAuthSummary.mockResolvedValue(null);
    mockedMcp.resetMcpAuthToAuto.mockResolvedValue({
      name: "secure",
      status: { status: "needs_auth" },
    });
  });

  afterEach(() => {
    clearMcpAddWizard();
    clearMcpAuthWizard();
    clearMcpCredentialWizard();
    mockedMcp.createMcpServerFromInput.mockClear();
    mockedMcp.loadMcpServers.mockClear();
    mockedMcp.startMcpOAuth.mockClear();
    mockedMcp.completeMcpOAuth.mockClear();
    mockedMcp.resolveMcpRemoteUrl.mockClear();
    mockedMcp.configureSecureMcpAuth.mockClear();
    mockedMcp.getMcpAuthSummary.mockClear();
    mockedMcp.resetMcpAuthToAuto.mockClear();
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


  it("navigates backward through add-MCP steps on the same General panel", async () => {
    const startCtx = createContext();
    await startMcpAddWizard(startCtx);

    const nameCtx = createTextContext("demo-server");
    expect(await handleMcpsMessage(nameCtx)).toBe(true);
    expect(nameCtx.api.editMessageText).toHaveBeenCalledWith(
      777,
      4242,
      expect.stringContaining("2/3 · Server type"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    await selectMcpAddType(startCtx, "remote");
    expect(startCtx.api.editMessageText).toHaveBeenLastCalledWith(
      777,
      4242,
      expect.stringContaining("3/3 · Server URL"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    expect(await backMcpAddWizard(startCtx)).toBe(true);
    expect(startCtx.api.editMessageText).toHaveBeenLastCalledWith(
      777,
      4242,
      expect.stringContaining("2/3 · Server type"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    expect(await backMcpAddWizard(startCtx)).toBe(true);
    expect(startCtx.api.editMessageText).toHaveBeenLastCalledWith(
      777,
      4242,
      expect.stringContaining("1/3 · Server name"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(startCtx.reply).not.toHaveBeenCalled();
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
      expect.stringContaining(t("mcps.auth.sign_in_steps")),
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

    mockedMcp.loadMcpServers.mockResolvedValue([
      { name: "sentry", status: { status: "connected" } },
    ]);

    const ctx = createTextContext("http://127.0.0.1/callback?code=secret-code&state=oauth-state");
    expect(await handleMcpsMessage(ctx)).toBe(true);
    expect(mockedMcp.completeMcpOAuth).toHaveBeenCalledWith("/work/repo", "sentry", "secret-code");
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(777, 600);
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("detail");
    expect(interactionManager.getSnapshot()?.metadata.serverName).toBe("sentry");
  });
  it("opens credential auth choices by editing only the canonical General panel", async () => {
    const ctx = createContext();

    await startMcpCredentialWizard(ctx, {
      serverName: "secure",
      projectDirectory: "/work/repo",
      messageId: 4242,
    });

    expect(mockedMcp.resolveMcpRemoteUrl).toHaveBeenCalledWith("/work/repo", "secure");
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.api.editMessageText).toHaveBeenCalledWith(
      777,
      4242,
      expect.stringContaining("Authentication · secure"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("auth_setup");
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("menu");
    expect(interactionManager.getSnapshot()?.expectedInput).toBe("callback");
  });

  it("collects a bearer token without echoing it and restores the server detail in-place", async () => {
    const startCtx = createContext();
    await startMcpCredentialWizard(startCtx, {
      serverName: "secure",
      projectDirectory: "/work/repo",
      messageId: 4242,
    });
    await selectMcpCredentialMode(startCtx, "bearer");
    mockedMcp.loadMcpServers.mockResolvedValue([
      { name: "secure", status: { status: "connected" } },
    ]);

    const ctx = createTextContext("very-secret-token");
    expect(await handleMcpsMessage(ctx)).toBe(true);

    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(777, 600);
    expect(mockedMcp.configureSecureMcpAuth).toHaveBeenCalledWith({
      projectDirectory: "/work/repo",
      serverName: "secure",
      remoteUrl: "https://mcp.example.com/mcp",
      mode: "bearer",
      secret: "very-secret-token",
    });
    const renderedText = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[2] ?? ""))
      .join("\n");
    expect(renderedText).not.toContain("very-secret-token");
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("detail");
  });

  it("uses X-API-Key as the clean default API-key header", async () => {
    const startCtx = createContext();
    await startMcpCredentialWizard(startCtx, {
      serverName: "secure",
      projectDirectory: "/work/repo",
      messageId: 4242,
    });
    await selectMcpCredentialMode(startCtx, "api-key");
    mockedMcp.loadMcpServers.mockResolvedValue([
      { name: "secure", status: { status: "connected" } },
    ]);

    const ctx = createTextContext("api-key-value");
    expect(await handleMcpsMessage(ctx)).toBe(true);

    expect(mockedMcp.configureSecureMcpAuth).toHaveBeenCalledWith({
      projectDirectory: "/work/repo",
      serverName: "secure",
      remoteUrl: "https://mcp.example.com/mcp",
      mode: "api-key",
      headerName: "X-API-Key",
      secret: "api-key-value",
    });
  });

  it("collects a custom header name before its secret and deletes both input messages", async () => {
    const startCtx = createContext();
    await startMcpCredentialWizard(startCtx, {
      serverName: "secure",
      projectDirectory: "/work/repo",
      messageId: 4242,
    });
    await selectMcpCredentialMode(startCtx, "custom-header");

    const headerCtx = createTextContext("X-Service-Token");
    expect(await handleMcpsMessage(headerCtx)).toBe(true);
    expect(headerCtx.api.deleteMessage).toHaveBeenCalledWith(777, 600);
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("secret");

    mockedMcp.loadMcpServers.mockResolvedValue([
      { name: "secure", status: { status: "connected" } },
    ]);
    const secretCtx = createTextContext("custom-secret");
    expect(await handleMcpsMessage(secretCtx)).toBe(true);
    expect(secretCtx.api.deleteMessage).toHaveBeenCalledWith(777, 600);
    expect(mockedMcp.configureSecureMcpAuth).toHaveBeenCalledWith({
      projectDirectory: "/work/repo",
      serverName: "secure",
      remoteUrl: "https://mcp.example.com/mcp",
      mode: "custom-header",
      headerName: "X-Service-Token",
      secret: "custom-secret",
    });
  });

  it("collects a pre-registered OAuth client and then opens native OAuth login", async () => {
    const startCtx = createContext();
    mockedMcp.configureSecureMcpAuth.mockResolvedValueOnce({
      name: "secure",
      status: { status: "needs_auth" },
    });

    await startMcpCredentialWizard(startCtx, {
      serverName: "secure",
      projectDirectory: "/work/repo",
      messageId: 4242,
      preferredMode: "oauth-client",
    });

    const clientIdCtx = createTextContext("client-id");
    expect(await handleMcpsMessage(clientIdCtx)).toBe(true);
    expect(clientIdCtx.api.deleteMessage).toHaveBeenCalledWith(777, 600);
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("client-secret");

    const secretCtx = createTextContext("client-secret");
    expect(await handleMcpsMessage(secretCtx)).toBe(true);
    expect(secretCtx.api.deleteMessage).toHaveBeenCalledWith(777, 600);
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("scope");

    const scopeCtx = createTextContext("tools.read");
    expect(await handleMcpsMessage(scopeCtx)).toBe(true);
    expect(scopeCtx.api.deleteMessage).toHaveBeenCalledWith(777, 600);
    expect(mockedMcp.configureSecureMcpAuth).toHaveBeenCalledWith({
      projectDirectory: "/work/repo",
      serverName: "secure",
      remoteUrl: "https://mcp.example.com/mcp",
      mode: "oauth-client",
      clientId: "client-id",
      clientSecret: "client-secret",
      scope: "tools.read",
    });
    expect(mockedMcp.startMcpOAuth).toHaveBeenCalledWith("/work/repo", "secure");
    expect(interactionManager.getSnapshot()?.metadata.stage).toBe("auth");
  });

  it("moves Back through OAuth-client credential steps before returning to the auth menu", async () => {
    const startCtx = createContext();
    await startMcpCredentialWizard(startCtx, {
      serverName: "secure",
      projectDirectory: "/work/repo",
      messageId: 4242,
      preferredMode: "oauth-client",
    });

    expect(await handleMcpsMessage(createTextContext("client-id"))).toBe(true);
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("client-secret");

    expect(await handleMcpsMessage(createTextContext("client-secret"))).toBe(true);
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("scope");

    expect(await backMcpCredentialWizard(startCtx)).toBe(true);
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("client-secret");

    expect(await backMcpCredentialWizard(startCtx)).toBe(true);
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("client-id");

    expect(await backMcpCredentialWizard(startCtx)).toBe(true);
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("menu");
    expect(startCtx.reply).not.toHaveBeenCalled();
  });

  it("supports public OAuth clients by skipping Client Secret and scope", async () => {
    const startCtx = createContext();
    mockedMcp.configureSecureMcpAuth.mockResolvedValueOnce({
      name: "secure",
      status: { status: "needs_auth" },
    });
    await startMcpCredentialWizard(startCtx, {
      serverName: "secure",
      projectDirectory: "/work/repo",
      messageId: 4242,
      preferredMode: "oauth-client",
    });

    const clientIdCtx = createTextContext("public-client");
    expect(await handleMcpsMessage(clientIdCtx)).toBe(true);

    expect(await skipMcpCredentialOptionalStep(startCtx, "secret")).toBe(true);
    expect(interactionManager.getSnapshot()?.metadata.step).toBe("scope");
    expect(await skipMcpCredentialOptionalStep(startCtx, "scope")).toBe(true);

    expect(mockedMcp.configureSecureMcpAuth).toHaveBeenCalledWith({
      projectDirectory: "/work/repo",
      serverName: "secure",
      remoteUrl: "https://mcp.example.com/mcp",
      mode: "oauth-client",
      clientId: "public-client",
    });
    expect(mockedMcp.startMcpOAuth).toHaveBeenCalledWith("/work/repo", "secure");
  });

});

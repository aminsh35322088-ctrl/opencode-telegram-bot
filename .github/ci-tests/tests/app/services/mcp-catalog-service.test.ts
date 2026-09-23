import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  authStart: vi.fn(),
  authCallback: vi.fn(),
  authRemove: vi.fn(),
  disconnect: vi.fn(),
  add: vi.fn(),
  configGet: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    config: { get: mocked.configGet },
    mcp: {
      auth: {
        start: mocked.authStart,
        callback: mocked.authCallback,
        remove: mocked.authRemove,
      },
      disconnect: mocked.disconnect,
      add: mocked.add,
    },
  },
}));

const mockedCredentials = vi.hoisted(() => ({
  save: vi.fn(),
  load: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../../src/app/services/mcp-credential-store.js", () => ({
  saveMcpCredential: mockedCredentials.save,
  loadMcpCredential: mockedCredentials.load,
  listMcpCredentials: mockedCredentials.list,
  removeMcpCredential: mockedCredentials.remove,
}));

import {
  completeMcpOAuth,
  configureSecureMcpAuth,
  getMcpAuthSummary,
  parseMcpCatalogServers,
  resetMcpAuthToAuto,
  resolveMcpRemoteUrl,
  restoreSecureMcpConnections,
  startMcpOAuth,
} from "../../../src/app/services/mcp-catalog-service.js";
import { logger } from "../../../src/utils/logger.js";

describe("app/services/mcp-catalog-service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocked.authStart.mockReset();
    mocked.authCallback.mockReset();
    mocked.authRemove.mockReset();
    mocked.disconnect.mockReset();
    mocked.add.mockReset();
    mocked.configGet.mockReset();
    mockedCredentials.save.mockReset();
    mockedCredentials.load.mockReset();
    mockedCredentials.list.mockReset();
    mockedCredentials.remove.mockReset();
  });

  it("parses a dictionary-form catalog", () => {
    const servers = parseMcpCatalogServers({
      "server-a": { status: "connected" },
      "server-b": { status: "disabled" },
    });

    expect(servers).toEqual([
      { name: "server-a", status: { status: "connected" } },
      { name: "server-b", status: { status: "disabled" } },
    ]);
  });

  it("parses an array-form catalog", () => {
    const servers = parseMcpCatalogServers([
      { name: "server-a", status: { status: "needs_auth" } },
    ]);

    expect(servers).toEqual([{ name: "server-a", status: { status: "needs_auth" } }]);
  });

  it("keeps the error on failed servers", () => {
    const servers = parseMcpCatalogServers({
      "server-broken": { status: "failed", error: "boom" },
    });

    expect(servers).toEqual([
      { name: "server-broken", status: { status: "failed", error: "boom" } },
    ]);
  });

  it("normalizes a missing error on failed servers to an empty string", () => {
    const servers = parseMcpCatalogServers({
      "server-broken": { status: "failed" },
    });

    expect(servers).toEqual([
      { name: "server-broken", status: { status: "failed", error: "" } },
    ]);
  });

  it("skips servers with an unknown status string but keeps the rest", () => {
    const warnSpy = vi.spyOn(logger, "debug");
    const servers = parseMcpCatalogServers({
      "server-future": { status: "connecting" },
      "server-ok": { status: "connected" },
    });

    expect(servers).toEqual([{ name: "server-ok", status: { status: "connected" } }]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[McpCatalog] Unknown MCP status "connecting", skipping server',
    );
  });

  it("returns null for structurally broken input", () => {
    expect(parseMcpCatalogServers(null)).toBeNull();
    expect(parseMcpCatalogServers(42)).toBeNull();
    expect(parseMcpCatalogServers({ "server-a": "not-an-object" })).toBeNull();
    expect(parseMcpCatalogServers({ "server-a": { status: 42 } })).toBeNull();
    expect(parseMcpCatalogServers([{ name: "server-a", status: null }])).toBeNull();
  });

  it("starts MCP OAuth through OpenCode and preserves state", async () => {
    mocked.authStart.mockResolvedValue({
      data: {
        authorizationUrl: "https://login.example/authorize",
        oauthState: "state-123",
      },
      error: undefined,
    });

    await expect(startMcpOAuth("C:\\repo", "sentry")).resolves.toEqual({
      authorizationUrl: "https://login.example/authorize",
      oauthState: "state-123",
    });
    expect(mocked.authStart).toHaveBeenCalledWith({
      name: "sentry",
      directory: "C:/repo",
    });
  });

  it("rejects unsafe OAuth authorization URL schemes", async () => {
    mocked.authStart.mockResolvedValue({
      data: {
        authorizationUrl: "javascript:alert(1)",
        oauthState: "state-123",
      },
      error: undefined,
    });

    await expect(startMcpOAuth("/repo", "unsafe")).rejects.toThrow(
      "authorization URL must use HTTPS or HTTP",
    );
  });

  it("completes MCP OAuth through OpenCode and returns the connected status", async () => {
    mocked.authCallback.mockResolvedValue({
      data: { status: "connected" },
      error: undefined,
    });

    await expect(completeMcpOAuth("/repo", "sentry", "oauth-code")).resolves.toEqual({
      name: "sentry",
      status: { status: "connected" },
    });
    expect(mocked.authCallback).toHaveBeenCalledWith({
      name: "sentry",
      directory: "/repo",
      code: "oauth-code",
    });
  });
  it("configures a bearer token only through OpenCode's in-memory MCP add API", async () => {
    mocked.add.mockResolvedValue({
      data: { secure: { status: "connected" } },
      error: undefined,
    });
    mockedCredentials.save.mockResolvedValue(undefined);

    const record = {
      projectDirectory: "C:\\repo",
      serverName: "secure",
      remoteUrl: "https://mcp.example.com/mcp",
      mode: "bearer" as const,
      secret: "bearer-secret",
    };

    await expect(configureSecureMcpAuth(record)).resolves.toEqual({
      name: "secure",
      status: { status: "connected" },
    });

    expect(mocked.add).toHaveBeenCalledWith({
      directory: "C:/repo",
      name: "secure",
      config: {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        oauth: false,
        headers: { Authorization: "Bearer bearer-secret" },
      },
    });
    expect(mockedCredentials.save).toHaveBeenCalledWith(record);
  });

  it("configures API-key headers in memory and rejects header injection", async () => {
    mocked.add.mockResolvedValue({
      data: { context: { status: "connected" } },
      error: undefined,
    });
    mockedCredentials.save.mockResolvedValue(undefined);

    await configureSecureMcpAuth({
      projectDirectory: "/repo",
      serverName: "context",
      remoteUrl: "https://context.example/mcp",
      mode: "api-key",
      headerName: "X-API-Key",
      secret: "api-secret",
    });

    expect(mocked.add).toHaveBeenCalledWith({
      directory: "/repo",
      name: "context",
      config: {
        type: "remote",
        url: "https://context.example/mcp",
        oauth: false,
        headers: { "X-API-Key": "api-secret" },
      },
    });

    await expect(configureSecureMcpAuth({
      projectDirectory: "/repo",
      serverName: "unsafe",
      remoteUrl: "https://unsafe.example/mcp",
      mode: "custom-header",
      headerName: "X-Token\r\nAuthorization",
      secret: "secret",
    })).rejects.toThrow(/header name/i);
  });

  it("rejects CRLF in custom header secret values", async () => {
    await expect(configureSecureMcpAuth({
      projectDirectory: "/repo",
      serverName: "unsafe",
      remoteUrl: "https://unsafe.example/mcp",
      mode: "custom-header",
      headerName: "X-Service-Token",
      secret: "abc\r\nInjected: yes",
    })).rejects.toThrow(/header value/i);
    expect(mocked.add).not.toHaveBeenCalled();
    expect(mockedCredentials.save).not.toHaveBeenCalled();
  });

  it("configures a pre-registered OAuth client in OpenCode memory", async () => {
    mocked.add.mockResolvedValue({
      data: { sentry: { status: "needs_auth" } },
      error: undefined,
    });
    mockedCredentials.save.mockResolvedValue(undefined);

    const record = {
      projectDirectory: "/repo",
      serverName: "sentry",
      remoteUrl: "https://mcp.sentry.example/mcp",
      mode: "oauth-client" as const,
      clientId: "client-id",
      clientSecret: "client-secret",
      scope: "tools.read",
    };

    await expect(configureSecureMcpAuth(record)).resolves.toEqual({
      name: "sentry",
      status: { status: "needs_auth" },
    });
    expect(mocked.add).toHaveBeenCalledWith({
      directory: "/repo",
      name: "sentry",
      config: {
        type: "remote",
        url: "https://mcp.sentry.example/mcp",
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          scope: "tools.read",
        },
      },
    });
    expect(mockedCredentials.save).toHaveBeenCalledWith(record);
  });

  it("restores secure MCP definitions after OpenCode restart without rewriting credentials", async () => {
    mockedCredentials.list.mockResolvedValue([
      {
        projectDirectory: "/repo",
        serverName: "one",
        remoteUrl: "https://one.example/mcp",
        mode: "bearer",
        secret: "one-secret",
      },
      {
        projectDirectory: "/repo",
        serverName: "two",
        remoteUrl: "https://two.example/mcp",
        mode: "oauth-client",
        clientId: "two-client",
        clientSecret: "two-secret",
      },
    ]);
    mocked.add
      .mockResolvedValueOnce({ data: { one: { status: "connected" } }, error: undefined })
      .mockResolvedValueOnce({ data: { two: { status: "needs_auth" } }, error: undefined });

    await expect(restoreSecureMcpConnections()).resolves.toEqual({ restored: 2, failed: 0 });
    expect(mocked.add).toHaveBeenCalledTimes(2);
    expect(mockedCredentials.save).not.toHaveBeenCalled();
  });

  it("continues restoring other MCPs when one secure definition fails", async () => {
    mockedCredentials.list.mockResolvedValue([
      {
        projectDirectory: "/repo",
        serverName: "broken",
        remoteUrl: "https://broken.example/mcp",
        mode: "bearer",
        secret: "never-log-this",
      },
      {
        projectDirectory: "/repo",
        serverName: "healthy",
        remoteUrl: "https://healthy.example/mcp",
        mode: "bearer",
        secret: "healthy-secret",
      },
    ]);
    mocked.add
      .mockResolvedValueOnce({ data: undefined, error: { message: "connection failed" } })
      .mockResolvedValueOnce({ data: { broken: { status: "needs_auth" } }, error: undefined })
      .mockResolvedValueOnce({ data: { healthy: { status: "connected" } }, error: undefined });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(restoreSecureMcpConnections()).resolves.toEqual({ restored: 1, failed: 1 });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("never-log-this");
  });

  it("fails closed without crashing startup when the encrypted credential set cannot be opened", async () => {
    mockedCredentials.list.mockRejectedValue(new Error("Unable to decrypt stored MCP credential."));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(restoreSecureMcpConnections()).resolves.toEqual({ restored: 0, failed: 1 });
    expect(mocked.add).not.toHaveBeenCalled();
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("secret");
  });

  it("returns a non-secret auth summary for UI and model-safe status surfaces", async () => {
    mockedCredentials.load.mockResolvedValue({
      projectDirectory: "/repo",
      serverName: "secure",
      remoteUrl: "https://secure.example/mcp",
      mode: "custom-header",
      headerName: "X-Service-Token",
      secret: "hidden-value",
    });

    const summary = await getMcpAuthSummary("/repo", "secure");
    expect(summary).toEqual({
      mode: "custom-header",
      headerName: "X-Service-Token",
      configured: true,
    });
    expect(JSON.stringify(summary)).not.toContain("hidden-value");
  });

  it("resolves the remote URL from the encrypted credential store before reading OpenCode config", async () => {
    mockedCredentials.load.mockResolvedValue({
      projectDirectory: "/repo",
      serverName: "secure",
      remoteUrl: "https://secure.example/mcp",
      mode: "bearer",
      secret: "hidden",
    });

    await expect(resolveMcpRemoteUrl("/repo", "secure")).resolves.toBe("https://secure.example/mcp");
    expect(mocked.configGet).not.toHaveBeenCalled();
  });

  it("resolves an uncredentialed remote URL from OpenCode config", async () => {
    mockedCredentials.load.mockResolvedValue(null);
    mocked.configGet.mockResolvedValue({
      data: {
        mcp: {
          context7: { type: "remote", url: "https://mcp.context7.example/mcp" },
        },
      },
      error: undefined,
    });

    await expect(resolveMcpRemoteUrl("/repo", "context7")).resolves.toBe(
      "https://mcp.context7.example/mcp",
    );
    expect(mocked.configGet).toHaveBeenCalledWith({ directory: "/repo" });
  });

  it("supports the nested mcp.servers config shape when resolving a remote URL", async () => {
    mockedCredentials.load.mockResolvedValue(null);
    mocked.configGet.mockResolvedValue({
      data: {
        mcp: {
          servers: {
            nested: { type: "remote", url: "https://nested.example/mcp" },
          },
        },
      },
      error: undefined,
    });

    await expect(resolveMcpRemoteUrl("/repo", "nested")).resolves.toBe(
      "https://nested.example/mcp",
    );
  });

  it("resets secure auth to native auto/OAuth in memory and removes the stored credential", async () => {
    mocked.add.mockResolvedValue({
      data: { secure: { status: "needs_auth" } },
      error: undefined,
    });
    mockedCredentials.remove.mockResolvedValue(true);

    await expect(resetMcpAuthToAuto({
      projectDirectory: "/repo",
      serverName: "secure",
      remoteUrl: "https://secure.example/mcp",
    })).resolves.toEqual({
      name: "secure",
      status: { status: "needs_auth" },
    });

    expect(mocked.add).toHaveBeenCalledWith({
      directory: "/repo",
      name: "secure",
      config: { type: "remote", url: "https://secure.example/mcp" },
    });
    expect(mockedCredentials.remove).toHaveBeenCalledWith("/repo", "secure");
  });

  it("does not persist a rejected bearer credential", async () => {
    mocked.add.mockResolvedValue({
      data: { secure: { status: "failed", error: "Unauthorized" } },
      error: undefined,
    });

    await expect(configureSecureMcpAuth({
      projectDirectory: "/repo",
      serverName: "secure",
      remoteUrl: "https://secure.example/mcp",
      mode: "bearer",
      secret: "wrong-secret",
    })).rejects.toThrow(/did not authenticate/i);

    expect(mockedCredentials.save).not.toHaveBeenCalled();
    expect(mocked.add).toHaveBeenCalledTimes(2);
    expect(mocked.add).toHaveBeenLastCalledWith({
      directory: "/repo",
      name: "secure",
      config: { type: "remote", url: "https://secure.example/mcp" },
    });
  });

  it("scrubs a secret-bearing dynamic definition when the initial secure MCP add errors", async () => {
    mocked.add
      .mockResolvedValueOnce({ data: undefined, error: { message: "transport failed" } })
      .mockResolvedValueOnce({ data: { secure: { status: "needs_auth" } }, error: undefined });

    await expect(configureSecureMcpAuth({
      projectDirectory: "/repo",
      serverName: "secure",
      remoteUrl: "https://secure.example/mcp",
      mode: "bearer",
      secret: "must-not-remain-in-memory",
    })).rejects.toThrow(/could not configure secure MCP/i);

    expect(mockedCredentials.save).not.toHaveBeenCalled();
    expect(mocked.add).toHaveBeenCalledTimes(2);
    expect(mocked.add).toHaveBeenLastCalledWith({
      directory: "/repo",
      name: "secure",
      config: { type: "remote", url: "https://secure.example/mcp" },
    });
  });

  it("scrubs an expired stored credential when secure MCP restoration is rejected", async () => {
    mockedCredentials.list.mockResolvedValue([
      {
        projectDirectory: "/repo",
        serverName: "expired",
        remoteUrl: "https://expired.example/mcp",
        mode: "bearer",
        secret: "expired-secret",
      },
    ]);
    mocked.add
      .mockResolvedValueOnce({
        data: { expired: { status: "failed", error: "Unauthorized" } },
        error: undefined,
      })
      .mockResolvedValueOnce({
        data: { expired: { status: "needs_auth" } },
        error: undefined,
      });

    await expect(restoreSecureMcpConnections()).resolves.toEqual({ restored: 0, failed: 1 });
    expect(mocked.add).toHaveBeenCalledTimes(2);
    expect(mocked.add).toHaveBeenLastCalledWith({
      directory: "/repo",
      name: "expired",
      config: { type: "remote", url: "https://expired.example/mcp" },
    });
  });

  it("does not persist an OAuth client that still requires client registration", async () => {
    mocked.add.mockResolvedValue({
      data: {
        enterprise: {
          status: "needs_client_registration",
          error: "Client registration required",
        },
      },
      error: undefined,
    });

    await expect(configureSecureMcpAuth({
      projectDirectory: "/repo",
      serverName: "enterprise",
      remoteUrl: "https://enterprise.example/mcp",
      mode: "oauth-client",
      clientId: "invalid-client",
      clientSecret: "invalid-secret",
    })).rejects.toThrow(/client registration/i);

    expect(mockedCredentials.save).not.toHaveBeenCalled();
  });

});

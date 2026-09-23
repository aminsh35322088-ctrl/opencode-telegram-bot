import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  authStart: vi.fn(),
  authCallback: vi.fn(),
  authRemove: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    mcp: {
      auth: {
        start: mocked.authStart,
        callback: mocked.authCallback,
        remove: mocked.authRemove,
      },
      disconnect: mocked.disconnect,
    },
  },
}));

import {
  completeMcpOAuth,
  parseMcpCatalogServers,
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
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mockedConfig = vi.hoisted(() => ({ token: "telegram-token-a" }));

vi.mock("../../../src/config.js", () => ({
  config: {
    get telegram() {
      return { token: mockedConfig.token, allowedUserId: 1, proxyUrl: "", apiRoot: "", proxySecret: "", forceIpv4: false };
    },
    opencode: {
      apiUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "",
      autoRestartEnabled: true,
      monitorIntervalSec: 20,
      model: { provider: "opencode", modelId: "big-pickle" },
    },
  },
}));

import {
  listMcpCredentials,
  loadMcpCredential,
  removeMcpCredential,
  saveMcpCredential,
} from "../../../src/app/services/mcp-credential-store.js";

describe("mcp credential store", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-credential-store-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    mockedConfig.token = "telegram-token-a";
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("encrypts bearer credentials at rest and restores the scoped record", async () => {
    await saveMcpCredential({
      projectDirectory: "/work/repo-a",
      serverName: "sentry",
      remoteUrl: "https://mcp.example.com/mcp",
      mode: "bearer",
      secret: "super-secret-bearer",
    });

    const stateText = await fs.readFile(path.join(home, "app-state.json"), "utf8");
    expect(stateText).not.toContain("super-secret-bearer");
    expect(stateText).not.toContain("https://mcp.example.com/mcp");

    await expect(loadMcpCredential("/work/repo-a", "sentry")).resolves.toEqual({
      projectDirectory: "/work/repo-a",
      serverName: "sentry",
      remoteUrl: "https://mcp.example.com/mcp",
      mode: "bearer",
      secret: "super-secret-bearer",
    });
    await expect(loadMcpCredential("/work/repo-b", "sentry")).resolves.toBeNull();
  });

  it("keeps credentials for different projects and servers isolated", async () => {
    await saveMcpCredential({
      projectDirectory: "/work/a",
      serverName: "one",
      remoteUrl: "https://one.example/mcp",
      mode: "api-key",
      headerName: "X-API-Key",
      secret: "one-secret",
    });
    await saveMcpCredential({
      projectDirectory: "/work/b",
      serverName: "two",
      remoteUrl: "https://two.example/mcp",
      mode: "oauth-client",
      clientId: "client-two",
      clientSecret: "two-secret",
      scope: "tools.read",
    });

    const records = await listMcpCredentials();
    expect(records).toHaveLength(2);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectDirectory: "/work/a", serverName: "one", secret: "one-secret" }),
      expect.objectContaining({ projectDirectory: "/work/b", serverName: "two", clientSecret: "two-secret" }),
    ]));
  });

  it("fails closed when ciphertext is tampered with", async () => {
    await saveMcpCredential({
      projectDirectory: "/work/repo",
      serverName: "secure",
      remoteUrl: "https://secure.example/mcp",
      mode: "custom-header",
      headerName: "X-Service-Token",
      secret: "top-secret",
    });

    const statePath = path.join(home, "app-state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      mcpCredentials?: { records?: Record<string, { ciphertext?: string }> };
    };
    const record = Object.values(state.mcpCredentials?.records ?? {})[0];
    expect(record?.ciphertext).toBeTruthy();
    record!.ciphertext = `${record!.ciphertext!.slice(0, -2)}AA`;
    await fs.writeFile(statePath, JSON.stringify(state));

    await expect(loadMcpCredential("/work/repo", "secure")).rejects.toThrow(/decrypt/i);
  });

  it("fails closed after the Telegram bot token changes", async () => {
    await saveMcpCredential({
      projectDirectory: "/work/repo",
      serverName: "secure",
      remoteUrl: "https://secure.example/mcp",
      mode: "bearer",
      secret: "bound-to-original-key",
    });

    mockedConfig.token = "telegram-token-b";

    await expect(loadMcpCredential("/work/repo", "secure")).rejects.toThrow(/decrypt/i);
  });

  it("removes one scoped credential without touching the others", async () => {
    await saveMcpCredential({
      projectDirectory: "/work/a",
      serverName: "one",
      remoteUrl: "https://one.example/mcp",
      mode: "bearer",
      secret: "one",
    });
    await saveMcpCredential({
      projectDirectory: "/work/a",
      serverName: "two",
      remoteUrl: "https://two.example/mcp",
      mode: "bearer",
      secret: "two",
    });

    await expect(removeMcpCredential("/work/a", "one")).resolves.toBe(true);
    await expect(loadMcpCredential("/work/a", "one")).resolves.toBeNull();
    await expect(loadMcpCredential("/work/a", "two")).resolves.toEqual(expect.objectContaining({ secret: "two" }));
    await expect(removeMcpCredential("/work/a", "missing")).resolves.toBe(false);
  });
});

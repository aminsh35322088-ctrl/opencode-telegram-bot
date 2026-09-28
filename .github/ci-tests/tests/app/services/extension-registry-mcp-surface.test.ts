import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: { token: "123456:registry-mcp-surface", allowedUserId: 1 },
    opencode: {
      apiUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "",
      autoRestartEnabled: false,
      monitorIntervalSec: 20,
      model: { provider: "opencode", modelId: "test-model" },
    },
  },
}));

const loadMcpServers = vi.hoisted(() => vi.fn());
const deleteMcpServer = vi.hoisted(() => vi.fn());

vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  loadMcpServers,
  deleteMcpServer,
}));

vi.mock("../../../src/app/services/opencode-managed-config-service.js", () => ({
  reloadManagedOpenCodeConfig: vi.fn(),
}));

vi.mock("../../../src/app/services/skills-catalog-service.js", () => ({
  loadSkillsCatalog: vi.fn().mockResolvedValue([]),
}));

import {
  getExtensionInfo,
  listExtensions,
  removeExtension,
} from "../../../src/app/services/extension-registry-service.js";
import { saveStoredExtension } from "../../../src/app/services/extension-store.js";
import { registerGeneratedActionPack } from "../../../src/app/services/generated-action-store.js";

describe("Extension registry MCP surface", () => {
  let home = "";
  const now = "2026-09-28T00:00:00.000Z";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "registry-mcp-surface-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    await saveStoredExtension({
      id: "mcp:railway",
      name: "railway",
      kind: "mcp",
      source: "https://mcp.railway.app",
      authType: "none",
      credentialSchemas: [],
      resource: { kind: "mcp", serverName: "railway", projectDirectory: "/work/repo" },
      createdAt: now,
      updatedAt: now,
      managed: true,
    });
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("lists bot-managed MCP records and reports a connected server as ready", async () => {
    loadMcpServers.mockResolvedValue([{ name: "railway", type: "remote", status: { status: "connected" } }]);

    const extensions = await listExtensions("/work/repo");
    expect(extensions.map((item) => item.id)).toEqual(["mcp:railway"]);
    expect(extensions[0]).toMatchObject({ kind: "mcp", status: "ready", managed: true });
    await expect(getExtensionInfo("/work/repo", "mcp:railway")).resolves.toMatchObject({ status: "ready" });
  });

  it("surfaces needs-auth so the user is told to sign in", async () => {
    loadMcpServers.mockResolvedValue([{ name: "railway", type: "remote", status: { status: "needs_auth" } }]);
    await expect(getExtensionInfo("/work/repo", "mcp:railway")).resolves.toMatchObject({ status: "needs-auth" });
  });

  it("reports unknown when the runtime cannot be reached instead of failing the list", async () => {
    loadMcpServers.mockRejectedValue(new Error("OpenCode unavailable"));
    await expect(getExtensionInfo("/work/repo", "mcp:railway")).resolves.toMatchObject({ status: "unknown" });
  });

  it("removes the underlying MCP server, not just the registry row", async () => {
    loadMcpServers.mockResolvedValue([{ name: "railway", type: "remote", status: { status: "connected" } }]);
    deleteMcpServer.mockResolvedValue({ deleted: true, name: "railway" });
    await registerGeneratedActionPack("mcp:railway", [{
      id: "railway.deploy",
      tool: "mcp",
      action: "call",
      description: "Deploy.",
      invocation: { kind: "mcp-tool", server: "railway", tool: "deploy" },
    }]);

    const result = await removeExtension("/work/repo", "mcp:railway");

    expect(result).toMatchObject({ removed: true, actionsRemoved: 1 });
    expect(deleteMcpServer).toHaveBeenCalledWith("/work/repo", "railway");
    expect(await listExtensions("/work/repo")).toEqual([]);
  });
});

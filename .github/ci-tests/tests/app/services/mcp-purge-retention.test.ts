import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: { token: "123456:mcp-purge-retention", allowedUserId: 1 },
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

import { cleanupLegacyUserConfiguration } from "../../../src/app/services/persistent-state-registry.js";
import { listStoredExtensions, saveStoredExtension } from "../../../src/app/services/extension-store.js";
import {
  listGeneratedActions,
  registerGeneratedActionPack,
} from "../../../src/app/services/generated-action-store.js";

describe("startup cleanup keeps bot-managed MCP Extensions", () => {
  let home = "";
  const now = "2026-09-28T00:00:00.000Z";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-purge-retention-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    process.env.HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    delete process.env.HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("retains managed MCP records and their generated tool actions across restarts", async () => {
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
    await saveStoredExtension({
      id: "mcp:graphify:legacy",
      name: "Graphify",
      kind: "mcp",
      source: "https://graphify.example/mcp",
      authType: "bearer",
      credentialSchemas: [],
      resource: { kind: "mcp", serverName: "graphify", projectDirectory: "/work/repo" },
      createdAt: now,
      updatedAt: now,
      managed: true,
    });
    await saveStoredExtension({
      id: "integration:free-model-source:qwen",
      name: "Qwen",
      kind: "integration",
      source: "https://qwen.example",
      authType: "api-key",
      credentialSchemas: [],
      resource: { kind: "integration", adapter: "free-model-source" },
      createdAt: now,
      updatedAt: now,
      managed: true,
    });

    await registerGeneratedActionPack("mcp:railway", [{
      id: "railway.deploy-latest",
      tool: "mcp",
      action: "call",
      description: "Deploy the latest build.",
      invocation: { kind: "mcp-tool", server: "railway", tool: "deploy_latest" },
    }]);
    await registerGeneratedActionPack("mcp:graphify:legacy", [{
      id: "graphify.query",
      tool: "mcp",
      action: "call",
      description: "Query Graphify.",
      invocation: { kind: "mcp-tool", server: "graphify", tool: "query" },
    }]);

    await cleanupLegacyUserConfiguration();

    // Bot-managed MCP survives; retired auto-created leftovers do not.
    expect((await listStoredExtensions()).map((item) => item.id)).toEqual(["mcp:railway"]);
    expect((await listGeneratedActions()).map((item) => item.id)).toEqual(["railway.deploy-latest"]);
  });

  it("drops generated actions whose owning MCP record is already gone", async () => {
    await registerGeneratedActionPack("mcp:absent", [{
      id: "absent.stale",
      tool: "mcp",
      action: "call",
      description: "Stale action with no owning Extension.",
      invocation: { kind: "mcp-tool", server: "absent", tool: "stale" },
    }]).catch(() => undefined);

    await cleanupLegacyUserConfiguration();

    expect(await listGeneratedActions()).toEqual([]);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverMcpToolIds: vi.fn(),
}));

vi.mock("../../../src/app/services/mcp-tool-discovery-service.js", () => ({
  discoverMcpToolIds: mocks.discoverMcpToolIds,
}));

vi.mock("../../../src/config.js", () => ({
  config: {
    opencode: {
      apiUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "",
    },
  },
}));

import { generateExtensionActions } from "../../../src/app/services/extension-action-generator-service.js";
import { listGeneratedActions } from "../../../src/app/services/generated-action-store.js";
import { saveStoredExtension } from "../../../src/app/services/extension-store.js";

describe("automatic Extension Action generation", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "extension-actions-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mocks.discoverMcpToolIds.mockResolvedValue([]);
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    vi.unstubAllGlobals();
    await fs.rm(home, { recursive: true, force: true });
  });
  it("creates a deterministic native skill.load action", async () => {
    const extension = {
      id: "skill:deploy-check",
      name: "deploy-check",
      kind: "skill" as const,
      source: "https://github.com/example/skills/deploy-check",
      purpose: "Check deployments",
      authType: "none" as const,
      credentialSchemas: [],
      resource: { kind: "skill" as const, skillName: "deploy-check" },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    };
    await saveStoredExtension(extension);

    await expect(generateExtensionActions(extension)).resolves.toBe(1);
    await expect(listGeneratedActions(extension.id)).resolves.toEqual([
      expect.objectContaining({
        id: "deploy.check.load",
        tool: "skill",
        action: "load",
        invocation: {
          kind: "native-tool",
          tool: "skill",
          arguments: { name: "deploy-check" },
        },
      }),
    ]);
  });
  it("discovers namespaced MCP tools from OpenCode and registers them in Actions", async () => {
    const extension = {
      id: "mcp:graphify:scope",
      name: "graphify",
      kind: "mcp" as const,
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
      authType: "oauth" as const,
      credentialSchemas: [],
      resource: {
        kind: "mcp" as const,
        serverName: "graphify",
        projectDirectory: "/work/repo",
      },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    };
    await saveStoredExtension(extension);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify([
        "bash",
        "read",
        "graphify_query",
        "graphify_graph_status",
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(generateExtensionActions(extension)).resolves.toBe(2);
    const actions = await listGeneratedActions(extension.id);
    expect(actions.map((item) => item.id)).toEqual([
      "graphify.graph_status",
      "graphify.query",
    ]);
    expect(actions.map((item) => item.tool)).toEqual([
      "graphify_graph_status",
      "graphify_query",
    ]);
    expect(actions.every((item) => item.invocation.kind === "mcp-tool")).toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(["graphify_query"]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    await expect(generateExtensionActions(extension)).resolves.toBe(1);
    expect((await listGeneratedActions(extension.id)).map((item) => item.id)).toEqual([
      "graphify.query",
    ]);
    expect(mocks.discoverMcpToolIds).not.toHaveBeenCalled();
  });

  it("falls back to direct MCP discovery when OpenCode omits MCP IDs", async () => {
    const extension = {
      id: "mcp:graphify:scope",
      name: "graphify",
      kind: "mcp" as const,
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
      authType: "oauth" as const,
      credentialSchemas: [],
      resource: {
        kind: "mcp" as const,
        serverName: "graphify",
        projectDirectory: "/work/repo",
      },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    };
    await saveStoredExtension(extension);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(["bash", "read"]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    mocks.discoverMcpToolIds.mockResolvedValue([
      "graphify_query",
      "graphify_graph_status",
    ]);

    await expect(generateExtensionActions(extension)).resolves.toBe(2);
    expect(mocks.discoverMcpToolIds).toHaveBeenCalledWith("/work/repo", "graphify");
    expect((await listGeneratedActions(extension.id)).map((item) => item.id)).toEqual([
      "graphify.graph_status",
      "graphify.query",
    ]);
  });

  it("marks generated MCP-backed Integration actions as integration Actions", async () => {
    const extension = {
      id: "integration:railway:scope",
      name: "railway",
      kind: "integration" as const,
      source: "https://railway.example/mcp",
      purpose: "Railway project operations",
      authType: "oauth" as const,
      credentialSchemas: [],
      resource: {
        kind: "mcp" as const,
        serverName: "railway",
        projectDirectory: "/work/repo",
      },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    };
    await saveStoredExtension(extension);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify([
        "railway_project_list",
        "railway_deployments_get",
        "bash",
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await expect(generateExtensionActions(extension)).resolves.toBe(2);
    const actions = await listGeneratedActions(extension.id);
    expect(actions.map((item) => item.id)).toEqual([
      "railway.deployments_get",
      "railway.project_list",
    ]);
    expect(actions.every((item) => item.category === "integration")).toBe(true);
    expect(actions.every((item) => item.invocation.kind === "mcp-tool")).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: vi.fn(),
  skills: vi.fn(),
  mcp: vi.fn(),
}));

vi.mock("../../../src/app/services/opencode-managed-config-service.js", () => ({
  reloadManagedOpenCodeConfig: vi.fn(),
}));
vi.mock("../../../src/app/services/skill-manage-service.js", () => ({
  deleteGlobalSkill: vi.fn(),
  isManagedSkillLocation: vi.fn((location: string) => location.includes(".opencode/skills")),
}));
vi.mock("../../../src/app/services/skills-catalog-service.js", () => ({
  loadSkillsCatalog: mocks.skills,
}));
vi.mock("../../../src/app/services/extension-store.js", () => ({
  listStoredExtensions: mocks.stored,
  getStoredExtension: vi.fn(async () => null),
  removeStoredExtension: vi.fn(),
  saveStoredExtension: vi.fn(),
}));
vi.mock("../../../src/app/services/credential-vault-service.js", () => ({
  removeExtensionCredentials: vi.fn(async () => 0),
}));
vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  loadMcpServers: mocks.mcp,
  deleteMcpServer: vi.fn(async () => ({ deleted: true, name: "graphify" })),
}));
vi.mock("../../../src/app/services/generated-action-store.js", () => ({
  removeGeneratedActionsForExtension: vi.fn(async () => 0),
}));

import { listExtensions } from "../../../src/app/services/extension-registry-service.js";

describe("Extension registry boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.skills.mockResolvedValue([]);
    mocks.mcp.mockResolvedValue([]);
    mocks.stored.mockResolvedValue([
      {
        id: "integration:tailscale",
        name: "Tailscale",
        kind: "integration",
        source: "tailscale",
        authType: "none",
        credentialSchemas: [],
        resource: { kind: "integration", adapter: "tailscale" },
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
        managed: true,
      },
      {
        id: "mcp:graphify",
        name: "Graphify",
        kind: "mcp",
        source: "https://graphify.example/mcp",
        authType: "none",
        credentialSchemas: [],
        resource: { kind: "mcp", serverName: "graphify", projectDirectory: "/work/repo" },
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
        managed: true,
      },
    ]);
  });

  it("keeps core integrations out of Extensions", async () => {
    // Tailscale stays a Core integration. Only Skills, plugins, and bot-managed
    // MCP servers belong in the Extensions surface.
    const result = await listExtensions("/work/repo");
    expect(result.map((item) => item.id)).toEqual(["mcp:graphify"]);
    expect(result.some((item) => item.id === "integration:tailscale")).toBe(false);
  });

  it("reports a bot-managed MCP server with its live runtime status", async () => {
    mocks.mcp.mockResolvedValue([
      { name: "graphify", type: "remote", status: { status: "connected" } },
    ]);

    await expect(listExtensions("/work/repo")).resolves.toEqual([
      expect.objectContaining({ id: "mcp:graphify", kind: "mcp", status: "ready" }),
    ]);
  });

  it("marks an unlisted MCP server as not connected rather than ready", async () => {
    mocks.mcp.mockResolvedValue([]);

    await expect(listExtensions("/work/repo")).resolves.toEqual([
      expect.objectContaining({ id: "mcp:graphify", status: "unknown" }),
    ]);
  });

  it("auto-discovers managed Skills", async () => {
    mocks.skills.mockResolvedValue([{
      name: "deploy-check",
      description: "Deployment checks",
      developer: "Example",
      location: "/work/repo/.opencode/skills/deploy-check/SKILL.md",
    }]);

    await expect(listExtensions("/work/repo")).resolves.toEqual([
      expect.objectContaining({
        id: "skill:deploy-check",
        name: "deploy-check",
        kind: "skill",
        status: "ready",
      }),
      expect.objectContaining({ id: "mcp:graphify", kind: "mcp" }),
    ]);
  });
});

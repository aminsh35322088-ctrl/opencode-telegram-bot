import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: vi.fn(),
  runtimeMcps: vi.fn(),
}));

vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  deleteCustomProvider: vi.fn(),
  listCustomProviders: vi.fn(async () => []),
}));
vi.mock("../../../src/app/services/opencode-managed-config-service.js", () => ({
  reloadManagedOpenCodeConfig: vi.fn(),
}));
vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  deleteMcpServer: vi.fn(),
  loadMcpServers: mocks.runtimeMcps,
}));
vi.mock("../../../src/app/services/mcp-server-store.js", () => ({
  listManagedMcpServers: vi.fn(async () => []),
}));
vi.mock("../../../src/app/services/skill-manage-service.js", () => ({
  deleteGlobalSkill: vi.fn(),
  isManagedSkillLocation: vi.fn(() => false),
}));
vi.mock("../../../src/app/services/skills-catalog-service.js", () => ({
  loadSkillsCatalog: vi.fn(async () => []),
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
vi.mock("../../../src/app/services/generated-action-store.js", () => ({
  removeGeneratedActionsForExtension: vi.fn(async () => 0),
}));

import { listExtensions } from "../../../src/app/services/extension-registry-service.js";

describe("Extension registry core boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeMcps.mockResolvedValue([]);
    mocks.stored.mockResolvedValue([{
      id: "integration:tailscale",
      name: "Tailscale",
      kind: "integration",
      source: "tailscale",
      purpose: "Legacy core integration record",
      authType: "api-key",
      credentialSchemas: [],
      resource: { kind: "integration", adapter: "tailscale" },
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      managed: true,
    }]);
  });

  it("does not synthesize Tailscale as an Extension", async () => {
    const extensions = await listExtensions("/work/repo");
    expect(extensions.some((item) => item.id === "integration:tailscale")).toBe(false);
    expect(extensions.some((item) => item.name === "Tailscale")).toBe(false);
  });

  it("reports pending MCP OAuth as needs-auth instead of ready", async () => {
    mocks.stored.mockResolvedValue([{
      id: "mcp:graphify:scope",
      name: "Graphify",
      kind: "mcp",
      source: "https://graphify.example/mcp",
      purpose: "Repository graph",
      authType: "oauth",
      credentialSchemas: [],
      resource: { kind: "mcp", serverName: "graphify", projectDirectory: "/work/repo" },
      createdAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
      managed: true,
    }]);
    mocks.runtimeMcps.mockResolvedValue([{
      name: "graphify",
      type: "remote",
      status: { status: "needs_auth" },
    }]);

    await expect(listExtensions("/work/repo")).resolves.toEqual([
      expect.objectContaining({
        id: "mcp:graphify:scope",
        name: "Graphify",
        status: "needs-auth",
      }),
    ]);
  });
});

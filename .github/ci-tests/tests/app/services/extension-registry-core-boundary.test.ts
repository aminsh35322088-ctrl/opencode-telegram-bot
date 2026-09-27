import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  deleteCustomProvider: vi.fn(),
  listCustomProviders: vi.fn(async () => []),
}));
vi.mock("../../../src/app/services/opencode-managed-config-service.js", () => ({
  reloadManagedOpenCodeConfig: vi.fn(),
}));
vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  deleteMcpServer: vi.fn(),
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
  listStoredExtensions: vi.fn(async () => [{
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
  }]),
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
  it("does not synthesize Tailscale as an Extension", async () => {
    const extensions = await listExtensions("/work/repo");
    expect(extensions.some((item) => item.id === "integration:tailscale")).toBe(false);
    expect(extensions.some((item) => item.name === "Tailscale")).toBe(false);
  });
});

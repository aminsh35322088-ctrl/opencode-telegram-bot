import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Extension automation boundary", () => {
  it("keeps Extension auto-setup on Skills/plugins while MCP uses its own managed actions", async () => {
    const source = await fs.readFile(".opencode/tools/bot.ts", "utf8");

    expect(source).toContain('"skills.add"');
    expect(source).toContain('"extensions.ensure"');
    expect(source).toContain('extension_kind: tool.schema.enum(["plugin"])');
    // MCP is provisioned through dedicated bot-managed actions, never through
    // the Extension approval flow.
    expect(source).toContain('"mcp.add"');
    expect(source).toContain('"mcp.tools"');
    expect(source).toContain('"mcp.call"');
    expect(source).not.toContain('"integrations.add"');
    expect(source).not.toContain('"providers.ensure"');
    expect(source).not.toContain('"credentials.request"');
    expect(source).not.toContain('"credentials.status"');
    expect(source).not.toContain("addMcpBackedExtension");
  });

  it("removes conversational MCP OAuth and secure credential automation", async () => {
    const ensure = await fs.readFile(
      "src/app/services/extension-ensure-service.ts",
      "utf8",
    );
    const ui = await fs.readFile(
      "src/bot/services/extension-automation-ui.ts",
      "utf8",
    );

    expect(ensure).not.toContain("startMcpOAuth");
    expect(ensure).not.toContain("completeExtensionOAuth");
    expect(ensure).not.toContain("finalizeExtensionCredential");
    expect(ui).not.toContain("oauthauto:");
    expect(ui).not.toContain("credauto:");
    expect(ui).not.toContain("secure-extension-credential");
  });

  it("auto-discovers only managed Skills in the Extension registry", async () => {
    const source = await fs.readFile(
      "src/app/services/extension-registry-service.ts",
      "utf8",
    );

    expect(source).toContain('record.kind === "skill" || record.kind === "plugin"');
    expect(source).toContain("loadSkillsCatalog");
    expect(source).not.toContain("listManagedMcpServers");
    expect(source).not.toContain("listCustomProviders");
    expect(source).not.toContain("loadMcpServers");
  });
});

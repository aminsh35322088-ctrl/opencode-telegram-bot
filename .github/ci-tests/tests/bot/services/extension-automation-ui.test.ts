import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Plugin-only Extension automation UI", () => {
  it("keeps plugin approval controls", async () => {
    const source = await fs.readFile(
      "src/bot/services/extension-automation-ui.ts",
      "utf8",
    );

    expect(source).toContain("extauto:a:");
    expect(source).toContain("extauto:c:");
    expect(source).toContain("approveExtensionEnsure");
    expect(source).toContain("Plugin setup completed");
  });

  it("does not expose MCP OAuth or secure credential flows", async () => {
    const source = await fs.readFile(
      "src/bot/services/extension-automation-ui.ts",
      "utf8",
    );

    expect(source).not.toContain("oauthauto:");
    expect(source).not.toContain("credauto:");
    expect(source).not.toContain("completeExtensionOAuth");
    expect(source).not.toContain("submitSecureCredential");
    expect(source).not.toContain("secure-extension-credential");
  });
});

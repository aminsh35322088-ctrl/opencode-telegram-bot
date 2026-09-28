import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerGeneratedActionPack,
  setGeneratedActionEnabled,
} from "../../../src/app/services/generated-action-store.js";
import { saveStoredExtension } from "../../../src/app/services/extension-store.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Risk classification is substring-based in production history and MCP tool
 * names are free-form, so these cases pin the segment-matching behavior that
 * keeps read verbs containing a mutating keyword from being escalated.
 */
describe("generated action risk classification", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "generated-action-risk-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function registerMcpAction(id: string, tool: string): Promise<string> {
    const now = new Date().toISOString();
    await saveStoredExtension({
      id: "mcp:probe",
      name: "probe",
      kind: "mcp",
      source: "https://mcp.example",
      authType: "none",
      credentialSchemas: [],
      resource: { kind: "mcp", serverName: "probe", projectDirectory: "/work/repo" },
      createdAt: now,
      updatedAt: now,
      managed: true,
    });
    const [record] = await registerGeneratedActionPack("mcp:probe", [{
      id: `probe.${id}`,
      tool: "mcp",
      action: "call",
      description: `probe ${id}`,
      invocation: { kind: "mcp-tool", server: "probe", tool },
    }]);
    return record!.risk;
  }

  it("keeps read verbs that merely contain a mutating keyword classified as read", async () => {
    await expect(registerMcpAction("list-deployments", "list_deployments")).resolves.toBe("read");
    await expect(registerMcpAction("show-updates", "show_updates")).resolves.toBe("read");
    await expect(registerMcpAction("get-commands", "get_commands")).resolves.toBe("read");
    await expect(registerMcpAction("read-writes", "read_writes")).resolves.toBe("read");
  });

  it("still escalates genuine mutating and destructive verbs", async () => {
    await expect(registerMcpAction("deploy", "deploy")).resolves.toBe("mutating");
    await expect(registerMcpAction("redeploy", "redeploy")).resolves.toBe("mutating");
    await expect(registerMcpAction("create-service", "create_service")).resolves.toBe("mutating");
    await expect(registerMcpAction("delete-service", "delete_service")).resolves.toBe("destructive");
    await expect(registerMcpAction("list-and-deploy", "list_and_deploy")).resolves.toBe("mutating");
  });

  it("falls back to external for verbs with no keyword", async () => {
    await expect(registerMcpAction("ping", "ping")).resolves.toBe("external");
  });

  it("keeps classification stable when a user disables an action", async () => {
    await expect(registerMcpAction("list-deployments", "list_deployments")).resolves.toBe("read");
    await expect(setGeneratedActionEnabled("probe.list-deployments", false)).resolves.toMatchObject({ risk: "read" });
  });
});

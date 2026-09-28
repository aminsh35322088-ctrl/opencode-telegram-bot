import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: { token: "123456:mcp-extension-actions", allowedUserId: 1 },
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

import {
  ensureMcpExtension,
  mcpExtensionId,
  removeMcpExtension,
  renameMcpExtension,
  syncMcpExtensionActions,
} from "../../../src/app/services/mcp-extension-service.js";
import { listGeneratedActions } from "../../../src/app/services/generated-action-store.js";
import { listStoredExtensions } from "../../../src/app/services/extension-store.js";

const listTools = vi.hoisted(() => vi.fn());

vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  listMcpServerTools: listTools,
}));

describe("MCP Extension record and generated tool actions", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-extension-actions-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("mirrors discovered tools into namespaced mcp-tool actions", async () => {
    listTools.mockResolvedValue({
      server: "railway",
      tools: [
        { name: "deploy_latest", description: "Deploy the latest build." },
        { name: "read log", description: "Read service logs.", inputSchema: { required: ["service"] } },
        { name: "github/get_issue", description: "Fetch an issue." },
      ],
    });

    await ensureMcpExtension({ serverName: "railway", projectDirectory: "/work/repo", source: "https://mcp.railway.app" });
    const result = await syncMcpExtensionActions({ serverName: "railway", projectDirectory: "/work/repo" });

    expect(result).toMatchObject({ created: 3, discovered: 3, truncated: false });
    const actions = await listGeneratedActions(mcpExtensionId("railway"));
    // listGeneratedActions returns records sorted by id.
    expect(actions.map((action) => action.id)).toEqual([
      "railway.deploy-latest",
      "railway.github-get-issue",
      "railway.read-log",
    ]);
    // The real MCP tool name is preserved even though the action ID is slugified.
    expect(actions.map((action) => action.invocation)).toEqual([
      { kind: "mcp-tool", server: "railway", tool: "deploy_latest" },
      { kind: "mcp-tool", server: "railway", tool: "github/get_issue" },
      { kind: "mcp-tool", server: "railway", tool: "read log" },
    ]);
    expect(actions.every((action) => action.tool === "mcp" && action.action === "call")).toBe(true);
    const byId = new Map(actions.map((action) => [action.id, action]));
    expect(byId.get("railway.read-log")?.description).toContain("Required arguments: service");
    expect(byId.get("railway.deploy-latest")?.description).toBe("Deploy the latest build.");
  });

  it("classifies risk from the MCP tool name", async () => {
    listTools.mockResolvedValue({
      server: "railway",
      tools: [{ name: "list_deployments" }, { name: "redeploy" }],
    });
    await ensureMcpExtension({ serverName: "railway", projectDirectory: "/work/repo", source: "https://mcp.railway.app" });
    await syncMcpExtensionActions({ serverName: "railway", projectDirectory: "/work/repo" });

    const actions = await listGeneratedActions(mcpExtensionId("railway"));
    expect(actions.find((action) => action.id === "railway.list-deployments")?.risk).toBe("read");
    expect(actions.find((action) => action.id === "railway.redeploy")?.risk).toBe("mutating");
  });

  it("resolves slug collisions deterministically without dropping tools", async () => {
    listTools.mockResolvedValue({
      server: "cf",
      tools: [{ name: "get zone" }, { name: "get-zone" }],
    });
    await ensureMcpExtension({ serverName: "cf", projectDirectory: "/work/repo", source: "https://mcp.cloudflare.com" });
    const result = await syncMcpExtensionActions({ serverName: "cf", projectDirectory: "/work/repo" });

    expect(result.created).toBe(2);
    const ids = (await listGeneratedActions(mcpExtensionId("cf"))).map((action) => action.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("cf.get-zone");
  });

  it("preserves user-disabled actions across a re-sync and drops removed tools", async () => {
    listTools.mockResolvedValue({
      server: "railway",
      tools: [{ name: "deploy_latest" }, { name: "read_log" }],
    });
    await ensureMcpExtension({ serverName: "railway", projectDirectory: "/work/repo", source: "https://mcp.railway.app" });
    await syncMcpExtensionActions({ serverName: "railway", projectDirectory: "/work/repo" });

    const { setGeneratedActionEnabled } = await import("../../../src/app/services/generated-action-store.js");
    await setGeneratedActionEnabled("railway.deploy-latest", false);

    listTools.mockResolvedValue({ server: "railway", tools: [{ name: "read_log" }] });
    await syncMcpExtensionActions({ serverName: "railway", projectDirectory: "/work/repo" });

    const remaining = await listGeneratedActions(mcpExtensionId("railway"));
    expect(remaining.map((action) => action.id)).toEqual(["railway.read-log"]);
  });

  it("keeps the record and reports why no actions were generated when discovery fails", async () => {
    listTools.mockRejectedValue(new Error("MCP endpoint requires authentication"));
    await ensureMcpExtension({ serverName: "gated", projectDirectory: "/work/repo", source: "https://mcp.example" });

    await expect(
      syncMcpExtensionActions({ serverName: "gated", projectDirectory: "/work/repo" }),
    ).rejects.toThrow(/requires authentication/);

    // The Extension record survives so the user can authenticate and retry.
    expect((await listStoredExtensions()).map((item) => item.id)).toEqual(["mcp:gated"]);
    expect(await listGeneratedActions(mcpExtensionId("gated"))).toEqual([]);
  });

  it("refuses to attach actions when no managed record exists", async () => {
    listTools.mockResolvedValue({ server: "ghost", tools: [] });
    await expect(
      syncMcpExtensionActions({ serverName: "ghost", projectDirectory: "/work/repo" }),
    ).rejects.toThrow(/no managed Extension record/);
  });

  it("removes the record and its actions together", async () => {
    listTools.mockResolvedValue({ server: "railway", tools: [{ name: "deploy_latest" }] });
    await ensureMcpExtension({ serverName: "railway", projectDirectory: "/work/repo", source: "https://mcp.railway.app" });
    await syncMcpExtensionActions({ serverName: "railway", projectDirectory: "/work/repo" });

    await expect(removeMcpExtension("railway")).resolves.toBe(true);
    expect(await listStoredExtensions()).toEqual([]);
    expect(await listGeneratedActions()).toEqual([]);
  });

  it("re-keys the record on rename so the namespace follows the new name", async () => {
    listTools.mockResolvedValue({ server: "railway", tools: [{ name: "deploy_latest" }] });
    await ensureMcpExtension({ serverName: "railway", projectDirectory: "/work/repo", source: "https://mcp.railway.app" });
    await syncMcpExtensionActions({ serverName: "railway", projectDirectory: "/work/repo" });

    await renameMcpExtension("railway", "Railway Cloud");

    expect((await listStoredExtensions()).map((item) => item.id)).toEqual(["mcp:railway cloud"]);
    expect(await listGeneratedActions()).toEqual([]);

    listTools.mockResolvedValue({ server: "Railway Cloud", tools: [{ name: "deploy_latest" }] });
    await syncMcpExtensionActions({ serverName: "Railway Cloud", projectDirectory: "/work/repo" });
    expect((await listGeneratedActions("mcp:railway cloud")).map((action) => action.id)).toEqual(["railway.cloud.deploy-latest"]);
  });

  it("caps a large tool set and reports the truncation", async () => {
    listTools.mockResolvedValue({
      server: "huge",
      tools: Array.from({ length: 130 }, (_, index) => ({ name: `tool_${index}` })),
    });
    await ensureMcpExtension({ serverName: "huge", projectDirectory: "/work/repo", source: "https://mcp.example" });
    const result = await syncMcpExtensionActions({ serverName: "huge", projectDirectory: "/work/repo" });

    expect(result).toMatchObject({ created: 100, discovered: 130, truncated: true });
  });
});

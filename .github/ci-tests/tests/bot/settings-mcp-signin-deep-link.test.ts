import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: { token: "123456:navigation-mcp-signin", allowedUserId: 1 },
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

vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  loadMcpServers,
}));

import {
  buildExtensionDetailView,
  resolveMcpServerRef,
  SETTINGS_EXTENSION_MCP_PREFIX,
} from "../../../src/bot/menus/extension-settings-menu.js";
import { ref } from "../../../src/bot/menus/menu-ref.js";

const AIRPLANE = { name: "railway", type: "remote", status: { status: "needs_auth" } };

describe("MCP sign-in deep link from Extensions", () => {
  it("emits a callback that identifies the server instead of routing to the list", async () => {
    loadMcpServers.mockResolvedValue([AIRPLANE]);
    const view = await buildExtensionDetailView("/work/repo", "mcp:railway");
    const signIn = view.keyboard.inline_keyboard
      .flat()
      .find((button) => typeof button?.text === "string" && button.text.includes("Sign in"));
    expect(signIn).toBeDefined();
    expect(signIn?.callback_data).toBe(`${SETTINGS_EXTENSION_MCP_PREFIX}${ref("railway")}`);
  });

  it("resolves the callback back to the exact server name", async () => {
    loadMcpServers.mockResolvedValue([AIRPLANE, { name: "graphify", type: "remote", status: { status: "needs_auth" } }]);
    await expect(resolveMcpServerRef("/work/repo", ref("railway"))).resolves.toBe("railway");
    await expect(resolveMcpServerRef("/work/repo", ref("graphify"))).resolves.toBe("graphify");
  });

  it("resolves case-insensitively so server casing cannot break the link", async () => {
    loadMcpServers.mockResolvedValue([{ name: "Railway", type: "remote", status: { status: "needs_auth" } }]);
    await expect(resolveMcpServerRef("/work/repo", ref("railway"))).resolves.toBe("Railway");
  });

  it("returns null for a stale or forged reference", async () => {
    loadMcpServers.mockResolvedValue([AIRPLANE]);
    await expect(resolveMcpServerRef("/work/repo", ref("deleted-server"))).resolves.toBeNull();
    await expect(resolveMcpServerRef("/work/repo", "not-a-ref")).resolves.toBeNull();
  });

  it("never routes sign-in through the MCP list screen", async () => {
    const source = await fs.readFile("src/bot/callbacks/settings-callback-handler.ts", "utf8");
    expect(source).toContain("renderMcpDetailView");
    expect(source).not.toContain('case SETTINGS_EXTENSION_MCP_CALLBACK');
    // The MCP list command must not be the sign-in destination.
    const signInBlock = source.slice(
      source.indexOf("SETTINGS_EXTENSION_MCP_PREFIX)) {"),
      source.indexOf("SETTINGS_EXTENSION_REMOVE_PREFIX)) {"),
    );
    expect(signInBlock).toContain("renderMcpDetailView");
    expect(signInBlock).not.toContain("mcpsCommand");
  });

  it("keeps the sign-in button hidden once a server is connected", async () => {
    loadMcpServers.mockResolvedValue([{ name: "railway", type: "remote", status: { status: "connected" } }]);
    const view = await buildExtensionDetailView("/work/repo", "mcp:railway");
    const labels = view.keyboard.inline_keyboard.flat().map((b) => (b as { text?: string } | null)?.text ?? "");
    expect(labels.some((label) => label.includes("Sign in"))).toBe(false);
  });
});

describe("navigation dead code removal", () => {
  it("no longer exports callbacks that nothing renders", async () => {
    const menu = await fs.readFile("src/bot/menus/settings-menu.ts", "utf8");
    const handler = await fs.readFile("src/bot/callbacks/settings-callback-handler.ts", "utf8");
    for (const dead of ["SETTINGS_MCP_CALLBACK", "SETTINGS_SKILLS_CALLBACK"]) {
      expect(menu).not.toContain(dead);
      expect(handler).not.toContain(dead);
    }
  });

  it("no longer shadows mcps:parent_back, so MCP wizard cleanup can run", async () => {
    const router = await fs.readFile("src/bot/callbacks/callback-router.ts", "utf8");
    const isAdvancedBack = router.slice(
      router.indexOf("const isAdvancedBack"),
      router.indexOf("const isAdvancedBack") + 300,
    );
    expect(isAdvancedBack).not.toContain("mcps:parent_back");
    // The MCP handler still owns the transition and its wizard teardown.
    const mcp = await fs.readFile("src/bot/callbacks/mcp-server-callback-handler.ts", "utf8");
    expect(mcp).toContain("MCPS_CALLBACK_PARENT_BACK");
    expect(mcp).toContain("dismissMcpAddWizard");
  });
});

describe("menu reference helper", () => {
  it("is stable, short, and case-insensitive", () => {
    expect(ref("railway")).toBe(ref("  Railway  "));
    expect(ref("railway")).toHaveLength(12);
    expect(ref("railway")).not.toBe(ref("graphify"));
  });
});

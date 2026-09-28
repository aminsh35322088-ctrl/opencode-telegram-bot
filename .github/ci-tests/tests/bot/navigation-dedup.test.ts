import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: { token: "123456:navigation-dedup", allowedUserId: 1 },
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

const listGithubAccounts = vi.hoisted(() => vi.fn());
const getActiveGithubAccount = vi.hoisted(() => vi.fn());
const loadMcpServers = vi.hoisted(() => vi.fn());

vi.mock("../../src/app/services/github-integration-service.js", () => ({
  listGithubAccounts,
  getActiveGithubAccount,
}));

vi.mock("../../src/app/services/mcp-server-service.js", () => ({ loadMcpServers }));

import { buildGithubSettingsView } from "../../src/bot/menus/extension-settings-menu.js";

const flat = (keyboard: { inline_keyboard: unknown[][] }): Array<{ text?: string; callback_data?: string }> =>
  keyboard.inline_keyboard.flat().filter(Boolean) as Array<{ text?: string; callback_data?: string }>;

describe("GitHub has a single management surface", () => {
  it("offers account selection and removal from the Settings view", async () => {
    listGithubAccounts.mockResolvedValue([
      { id: "a", name: "Personal" },
      { id: "b", name: "Work" },
    ]);
    getActiveGithubAccount.mockResolvedValue({ id: "a", name: "Personal", username: "amin" });

    const view = await buildGithubSettingsView();
    const data = flat(view.keyboard).map((b) => b.callback_data);
    expect(data).toContain("integration:github:select:a");
    expect(data).toContain("integration:github:select:b");
    expect(data).toContain("integration:github:remove:a");
    expect(data).toContain("integration:github:remove:b");
    expect(data).toContain("integration:github:add");
    expect(view.text).toContain("@amin");
  });

  it("marks the active account and still offers connect when none exist", async () => {
    listGithubAccounts.mockResolvedValue([{ id: "a", name: "Personal" }]);
    getActiveGithubAccount.mockResolvedValue({ id: "a", name: "Personal" });
    const withAccount = await buildGithubSettingsView();
    expect(flat(withAccount.keyboard).some((b) => b.text?.includes("✅"))).toBe(true);

    listGithubAccounts.mockResolvedValue([]);
    getActiveGithubAccount.mockResolvedValue(null);
    const empty = await buildGithubSettingsView();
    expect(flat(empty.keyboard).some((b) => b.callback_data === "integration:github:add")).toBe(true);
    expect(empty.text).toContain("Not connected");
  });

  it("keeps the user inside Settings instead of ejecting to another menu", async () => {
    listGithubAccounts.mockResolvedValue([]);
    getActiveGithubAccount.mockResolvedValue(null);
    const view = await buildGithubSettingsView();
    expect(flat(view.keyboard).some((b) => b.callback_data === "settings:back")).toBe(true);
    // No callback may target the deleted legacy hub.
    expect(flat(view.keyboard).some((b) => b.callback_data === "integration:menu")).toBe(false);
  });

  it("renders a completion notice when the wizard finishes", async () => {
    listGithubAccounts.mockResolvedValue([]);
    getActiveGithubAccount.mockResolvedValue(null);
    const view = await buildGithubSettingsView("✅ GitHub account added and selected.");
    expect(view.text).toContain("GitHub account added");
  });
});

describe("legacy Integrations hub removal", () => {
  it("no longer defines the hub view, its command, or its callbacks", async () => {
    const source = await fs.readFile("src/bot/commands/integrations-command.ts", "utf8");
    expect(source).not.toContain("showIntegrationsMenu");
    expect(source).not.toContain("integrationsCommand");
    expect(source).not.toContain("Legacy Connections");
    expect(source).not.toContain("integration:menu");
    expect(source).not.toContain("integration:close");
    expect(source).not.toContain("integration:advanced");
  });

  it("unregisters the /integrations command", async () => {
    const router = await fs.readFile("src/bot/routers/command-router.ts", "utf8");
    expect(router).not.toContain('bot.command("integrations"');
    expect(router).not.toContain("integrationsCommand");
  });

  it("returns wizard cancellation to Settings, which still exists", async () => {
    for (const file of ["src/bot/routers/message-router.ts", "src/bot/routers/reply-keyboard-router.ts"]) {
      const source = await fs.readFile(file, "utf8");
      expect(source).not.toContain("integrationsCommand");
    }
  });

  it("keeps the Tailscale surface, which had no other home", async () => {
    const source = await fs.readFile("src/bot/commands/integrations-command.ts", "utf8");
    for (const callback of [
      "integration:tailscale",
      "integration:tailscale:connect",
      "integration:tailscale:disconnect",
      "integration:tailscale:devices",
      "integration:tailscale:remove",
    ]) {
      expect(source).toContain(callback);
    }
  });

  it("keeps the GitHub wizard handlers the Settings view now emits", async () => {
    const source = await fs.readFile("src/bot/commands/integrations-command.ts", "utf8");
    expect(source).toContain("integration:github:add");
    expect(source).toContain("integration:github:select:");
    expect(source).toContain("integration:github:remove:");
    expect(source).toContain("addGithubAccount");
    expect(source).toContain("setActiveGithubAccount");
    expect(source).toContain("removeGithubAccount");
  });
});

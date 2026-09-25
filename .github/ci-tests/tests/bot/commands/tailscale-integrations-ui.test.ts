import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  reconnect: vi.fn(),
  disconnect: vi.fn(),
  remove: vi.fn(),
  status: vi.fn(),
  devices: vi.fn(),
}));

vi.mock("../../../src/app/services/github-integration-service.js", () => ({
  addGithubAccount: async () => ({ id: "github", name: "GitHub" }),
  getActiveGithubAccount: async () => null,
  listGithubAccounts: async () => [],
  removeGithubAccount: async () => false,
  setActiveGithubAccount: async () => ({ id: "github", name: "GitHub" }),
}));

vi.mock("../../../src/app/services/railway-integration-service.js", () => ({
  addRailwayAccount: async () => ({ id: "railway", name: "Railway" }),
  getActiveRailwayAccount: async () => null,
  listRailwayAccounts: async () => [],
  removeRailwayAccount: async () => false,
  setActiveRailwayAccount: async () => ({ id: "railway", name: "Railway" }),
  validateRailwayToken: async () => ({ valid: false, reason: "invalid" }),
}));

vi.mock("../../../src/app/services/tailscale-integration-service.js", () => ({
  configureTailscale: mocks.configure,
  reconnectTailscale: mocks.reconnect,
  disconnectTailscale: mocks.disconnect,
  removeTailscaleIntegration: mocks.remove,
  getTailscaleRuntimeStatus: mocks.status,
  listTailscaleSshDevices: mocks.devices,
}));

vi.mock("../../../src/bot/commands/providers-command.js", () => ({
  clearProviderWizard: vi.fn(),
}));

vi.mock("../../../src/bot/menus/settings-menu.js", () => ({
  buildAdvancedSettingsView: vi.fn(() => ({ text: "Advanced", keyboard: {} })),
}));

vi.mock("../../../src/bot/menus/inline-menu.js", () => ({
  appendHomeNavigation: (keyboard: unknown) => keyboard,
  replyWithInlineMenu: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getMainNavigationMessageId: () => 4242,
}));

import {
  clearIntegrationWizard,
  handleIntegrationMessage,
  handleIntegrationsCallback,
  isIntegrationWizardActive,
  showIntegrationsMenu,
} from "../../../src/bot/commands/integrations-command.js";

function callbackContext(data: string): Context {
  return {
    chat: { id: 777 },
    callbackQuery: { data, message: { message_id: 4242 } } as Context["callbackQuery"],
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

function textContext(text: string, messageId = 600): Context {
  return {
    chat: { id: 777 },
    message: { text, message_id: messageId } as Context["message"],
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

describe("Tailscale Integrations UI", () => {
  beforeEach(() => {
    clearIntegrationWizard();
    mocks.configure.mockReset().mockResolvedValue(undefined);
    mocks.reconnect.mockReset().mockResolvedValue(undefined);
    mocks.disconnect.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.status.mockReset().mockResolvedValue({
      configured: false,
      connected: false,
      daemonRunning: false,
      hostname: "opencode-bot",
      ips: [],
      sshDevices: 0,
    });
    mocks.devices.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    clearIntegrationWizard();
  });

  it("shows Tailscale as a first-class integration without a separate SSH server hub", async () => {
    const ctx = callbackContext("integration:menu");
    await showIntegrationsMenu(ctx);

    const call = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[2]).toContain("Tailscale: ⚪ Not configured");
    const callbacks = call?.[3]?.reply_markup.inline_keyboard.flat().map((button: { callback_data?: string }) => button.callback_data);
    expect(callbacks).toContain("integration:tailscale");
    expect(callbacks.some((value: string | undefined) => value?.includes("ssh:server"))).toBe(false);
  });

  it("connects from the canonical panel, deletes the auth-key message, and never echoes the key", async () => {
    const start = callbackContext("integration:tailscale:connect");
    expect(await handleIntegrationsCallback(start)).toBe(true);
    expect(isIntegrationWizardActive()).toBe(true);

    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      daemonRunning: true,
      hostname: "opencode-bot",
      tailnet: "example.ts.net",
      ips: ["100.64.0.2"],
      sshDevices: 1,
    });
    mocks.devices.mockResolvedValue([{ name: "github-exit", ips: ["100.64.0.10"], online: true, tags: ["tag:ssh"] }]);

    const input = textContext("tskey-auth-secret-value");
    expect(await handleIntegrationMessage(input)).toBe(true);

    expect(mocks.configure).toHaveBeenCalledWith("tskey-auth-secret-value");
    expect(input.api.deleteMessage).toHaveBeenCalledWith(777, 600);
    const edits = (input.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.stringify(edits)).not.toContain("tskey-auth-secret-value");
    expect(isIntegrationWizardActive()).toBe(false);
  });

  it("lists SSH devices discovered from tag:ssh peers", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      daemonRunning: true,
      hostname: "opencode-bot",
      ips: ["100.64.0.2"],
      sshDevices: 1,
    });
    mocks.devices.mockResolvedValue([
      { name: "github-exit", ips: ["100.64.0.10"], online: true, tags: ["tag:exit", "tag:ssh"] },
    ]);

    const ctx = callbackContext("integration:tailscale:devices");
    expect(await handleIntegrationsCallback(ctx)).toBe(true);

    const call = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[2]).toContain("github-exit");
    expect(call?.[2]).toContain("tag:ssh");
    expect(call?.[2]).toContain("discovered automatically");
  });
});

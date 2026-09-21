import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const rustDeskMocks = vi.hoisted(() => ({
  factory: vi.fn(),
  execute: vi.fn(),
  actions: ["bridge.health","servers.list","servers.get","servers.test","devices.list","devices.get","devices.connect","session.connectTemporary","connection.status","connection.disconnect","terminal.open","terminal.write","terminal.read","terminal.resize","terminal.close","terminal.exec","screen.capture","mouse.move","mouse.click","mouse.doubleClick","mouse.drag","mouse.scroll","keyboard.type","keyboard.press","touch.tap","touch.longPress","touch.swipe","clipboard.read","clipboard.write","files.list","files.read","files.upload","files.download","system.info","system.restart"],
}));

vi.mock("../../../src/app/services/rustdesk-bridge-service.js", () => ({
  createRustDeskBridgeClientFromEnv: rustDeskMocks.factory,
  RUSTDESK_ACTIONS: rustDeskMocks.actions,
  RUSTDESK_BRIDGE_CONTRACT_VERSION: 3,
}));

import { showRustDeskIntegrationMenu } from "../../../src/bot/commands/integrations-command.js";

function makeContext() {
  return {
    chat: { id: 42 },
    callbackQuery: {
      data: "integration:rustdesk",
      message: { message_id: 10, chat: { id: 42 } },
    },
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("RustDesk integrations settings", () => {
  beforeEach(() => {
    rustDeskMocks.factory.mockReset();
    rustDeskMocks.execute.mockReset();
  });

  it("shows bridge health and safe inventory counts", async () => {
    rustDeskMocks.execute.mockImplementation(async (request: { action: string }) => {
      if (request.action === "bridge.health") {
        return {
          ok: true,
          controlPlaneConfigured: true,
          contractVersion: 3,
          actions: rustDeskMocks.actions,
        };
      }
      if (request.action === "servers.list") {
        return { ok: true, servers: [{ id: "public" }, { id: "custom" }] };
      }
      if (request.action === "devices.list") {
        return { ok: true, devices: [{ id: "desktop" }] };
      }
      throw new Error("unexpected action");
    });
    rustDeskMocks.factory.mockReturnValue({ execute: rustDeskMocks.execute });
    const ctx = makeContext();

    await showRustDeskIntegrationMenu(ctx);

    const text = String((ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]);
    expect(text).toContain("🟢 Bridge online");
    expect(text).toContain("Server profiles: 2");
    expect(text).toContain("Permanent devices: 1");
    expect(text).toContain("Secure control plane: Ready");
    expect(text).toContain("Bridge contract: v3 · matched");
    expect(text).toContain("Model action surface: matched ✅");
    expect(text).toContain("never shown here or sent to the AI model");
  });

  it("exposes complete RustDesk inventory management navigation", async () => {
    rustDeskMocks.execute.mockImplementation(async (request: { action: string }) => {
      if (request.action === "bridge.health") return { ok: true, controlPlaneConfigured: true, contractVersion: 3 };
      if (request.action === "servers.list") return { ok: true, servers: [{ id: "rustdesk-public", name: "RustDesk Public" }] };
      if (request.action === "devices.list") return { ok: true, devices: [] };
      throw new Error("unexpected action");
    });
    rustDeskMocks.factory.mockReturnValue({ execute: rustDeskMocks.execute });
    const ctx = makeContext();

    await showRustDeskIntegrationMenu(ctx);

    const options = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> };
    };
    const labels = options?.reply_markup?.inline_keyboard?.flat().map((item) => item.text) ?? [];
    expect(labels).toContain("🖥 Devices");
    expect(labels).toContain("🌐 Server Profiles");
    expect(labels).toContain("⚡ Temporary Connection");
  });

  it("surfaces a bridge contract mismatch without hiding health", async () => {
    rustDeskMocks.execute.mockImplementation(async (request: { action: string }) => {
      if (request.action === "bridge.health") {
        return { ok: true, controlPlaneConfigured: true, contractVersion: 1 };
      }
      if (request.action === "servers.list") return { ok: true, servers: [] };
      if (request.action === "devices.list") return { ok: true, devices: [] };
      throw new Error("unexpected action");
    });
    rustDeskMocks.factory.mockReturnValue({ execute: rustDeskMocks.execute });
    const ctx = makeContext();

    await showRustDeskIntegrationMenu(ctx);

    const text = String((ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]);
    expect(text).toContain("🟢 Bridge online");
    expect(text).toContain("Bridge contract: v1 · expected v3");
  });

  it("shows a safe not-configured state", async () => {
    rustDeskMocks.factory.mockImplementation(() => {
      throw new Error("RustDesk agent tool is not configured. Set RUSTDESK_BRIDGE_URL first.");
    });
    const ctx = makeContext();

    await showRustDeskIntegrationMenu(ctx);

    const text = String((ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]);
    expect(text).toContain("⚪ Not configured");
    expect(text).toContain("RustDesk Core is not available in the trusted runtime.");
    expect(text).not.toContain("RUSTDESK_BRIDGE_URL");
  });

  it("shows configured-but-unavailable without exposing transport details", async () => {
    rustDeskMocks.factory.mockReturnValue({
      execute: vi.fn().mockRejectedValue(new Error("fixture transport failure")),
    });
    const ctx = makeContext();

    await showRustDeskIntegrationMenu(ctx);

    const text = String((ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]);
    expect(text).toContain("🔴 Bridge unavailable");
    expect(text).not.toContain("fixture transport failure");
  });
});

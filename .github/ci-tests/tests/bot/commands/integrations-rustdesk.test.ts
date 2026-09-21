[Reading 84 lines from start (total: 84 lines, 0 remaining)]

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const rustDeskMocks = vi.hoisted(() => ({
  factory: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../../../src/app/services/rustdesk-bridge-service.js", () => ({
  createRustDeskBridgeClientFromEnv: rustDeskMocks.factory,
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
        return { ok: true, controlPlaneConfigured: true };
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
    expect(text).toContain("never shown here or sent to the AI model");
  });

  it("shows a safe not-configured state", async () => {
    rustDeskMocks.factory.mockImplementation(() => {
      throw new Error("RustDesk agent tool is not configured. Set RUSTDESK_BRIDGE_URL first.");
    });
    const ctx = makeContext();

    await showRustDeskIntegrationMenu(ctx);

    const text = String((ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]);
    expect(text).toContain("⚪ Not configured");
    expect(text).toContain("RUSTDESK_BRIDGE_URL");
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

[executed on device: runnervmlun5p (3784ff4d-04bd-49e4-95bf-176085794429)]
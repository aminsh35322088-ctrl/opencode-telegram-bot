import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  executeAuthorized: vi.fn(),
  connectTemporaryFromSettings: vi.fn(),
  upsertServerProfile: vi.fn(),
  upsertDevice: vi.fn(),
  deleteServerProfile: vi.fn(),
  deleteDevice: vi.fn(),
  submitCredential: vi.fn(),
  factory: vi.fn(),
  canonicalMessageId: 777,
  actions: [
    "bridge.health", "servers.list", "servers.get", "servers.test",
    "devices.list", "devices.get", "devices.connect", "session.connectTemporary",
    "connection.status", "connection.disconnect", "terminal.open", "terminal.write",
    "terminal.read", "terminal.resize", "terminal.close", "terminal.exec", "screen.capture",
    "mouse.move", "mouse.click", "mouse.doubleClick", "mouse.drag", "mouse.scroll",
    "keyboard.type", "keyboard.press", "touch.tap", "touch.longPress", "touch.swipe",
    "clipboard.read", "clipboard.write", "files.list", "files.read", "files.upload",
    "files.download", "system.info", "system.restart",
  ],
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getMainNavigationMessageId: () => mocks.canonicalMessageId,
}));

vi.mock("../../../src/app/services/rustdesk-bridge-service.js", () => ({
  createRustDeskBridgeClientFromEnv: mocks.factory,
  RUSTDESK_ACTIONS: mocks.actions,
  RUSTDESK_BRIDGE_CONTRACT_VERSION: 3,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  clearRustDeskSettingsWizard,
  handleRustDeskSettingsCallback,
  handleRustDeskSettingsMessage,
} from "../../../src/bot/commands/rustdesk-settings-command.js";

function client() {
  return {
    execute: mocks.execute,
    executeAuthorized: mocks.executeAuthorized,
    connectTemporaryFromSettings: mocks.connectTemporaryFromSettings,
    upsertServerProfile: mocks.upsertServerProfile,
    upsertDevice: mocks.upsertDevice,
    deleteServerProfile: mocks.deleteServerProfile,
    deleteDevice: mocks.deleteDevice,
    submitCredential: mocks.submitCredential,
  };
}

function callbackCtx(data: string) {
  return {
    chat: { id: 42 },
    callbackQuery: { data, message: { message_id: 10, chat: { id: 42 } } },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function messageCtx(text: string, messageId = 100) {
  return {
    chat: { id: 42 },
    message: { message_id: messageId, text },
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("RustDesk settings wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRustDeskSettingsWizard();
    mocks.factory.mockReturnValue(client());
    mocks.execute.mockImplementation(async (request: { action: string }) => {
      if (request.action === "servers.list") {
        return { ok: true, servers: [{ id: "rustdesk-public", name: "RustDesk Public", kind: "public" }] };
      }
      if (request.action === "devices.list") return { ok: true, devices: [] };
      throw new Error(`unexpected action: ${request.action}`);
    });
    mocks.upsertServerProfile.mockResolvedValue({ ok: true });
    mocks.upsertDevice.mockResolvedValue({ ok: true });
  });

  it("adds a self-hosted server and deletes the private-key Telegram message", async () => {
    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:s:add"));
    await handleRustDeskSettingsMessage(messageCtx("Home Lab", 101));
    await handleRustDeskSettingsMessage(messageCtx("id.example.test", 102));
    await handleRustDeskSettingsMessage(messageCtx("relay.example.test", 103));
    await handleRustDeskSettingsMessage(messageCtx("-", 104));
    const secretCtx = messageCtx("server-private-key", 105);

    await handleRustDeskSettingsMessage(secretCtx);

    expect(mocks.upsertServerProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Home Lab",
        idServer: "id.example.test",
        relayServer: "relay.example.test",
        serverKey: "server-private-key",
      }),
    );
    expect(secretCtx.api.deleteMessage).toHaveBeenCalledWith(42, 105);
    expect(secretCtx.api.editMessageText).toHaveBeenCalledWith(
      42,
      777,
      expect.stringContaining("✅ Server profile added."),
      expect.any(Object),
    );
    expect(secretCtx.reply).not.toHaveBeenCalled();
  });

  it("adds a permanent public-server device with a Bridge-only credential", async () => {
    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:d:add"));
    await handleRustDeskSettingsMessage(messageCtx("My PC", 201));
    await handleRustDeskSettingsMessage(messageCtx("123456789", 202));
    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:w:server:rustdesk-public"));
    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:w:relay:no"));
    const secretCtx = messageCtx("permanent-secret", 203);

    await handleRustDeskSettingsMessage(secretCtx);

    expect(mocks.upsertDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My PC",
        rustdeskId: "123456789",
        serverProfileId: "rustdesk-public",
        forceRelay: false,
        credential: "permanent-secret",
      }),
    );
    expect(secretCtx.api.deleteMessage).toHaveBeenCalledWith(42, 203);
    expect(secretCtx.api.editMessageText).toHaveBeenCalledWith(
      42,
      777,
      expect.stringContaining("✅ Permanent device added."),
      expect.any(Object),
    );
    expect(secretCtx.reply).not.toHaveBeenCalled();
  });

  it("creates a temporary manual-approval connection from Settings", async () => {
    mocks.connectTemporaryFromSettings.mockResolvedValue({
      ok: true,
      connection: {
        connectionId: "conn-1",
        status: "connecting",
      },
    });

    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:temp"));
    await handleRustDeskSettingsMessage(messageCtx("987654321", 301));
    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:w:tserver:rustdesk-public"));
    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:w:auth:manual-approval"));

    expect(mocks.connectTemporaryFromSettings).toHaveBeenCalledWith({
      rustdeskId: "987654321",
      server: { kind: "public" },
      authMode: "manual-approval",
      serverKey: undefined,
    });
  });

  it("always edits the canonical General Panel instead of the callback message", async () => {
    const ctx = callbackCtx("integration:rd:d:add");

    await handleRustDeskSettingsCallback(ctx);

    expect(ctx.api.editMessageText).toHaveBeenCalledWith(
      42,
      777,
      expect.stringContaining("Permanent RustDesk Device"),
      expect.any(Object),
    );
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(42, 10);
  });

  it("parses nested saved-device connection responses without showing unknown", async () => {
    mocks.executeAuthorized.mockResolvedValue({
      ok: true,
      connection: {
        connectionId: "conn-saved-1",
        status: "connecting",
      },
    });
    mocks.execute.mockImplementation(async (request: { action: string }) => {
      if (request.action === "connection.status") {
        return {
          ok: true,
          connection: {
            connectionId: "conn-saved-1",
            status: "connected",
            error: null,
          },
        };
      }
      if (request.action === "devices.get") {
        return {
          ok: true,
          device: {
            id: "dev-1",
            name: "Phone",
            rustdeskId: "123456789",
            serverProfileId: "rustdesk-public",
            credentialConfigured: true,
            online: null,
          },
        };
      }
      throw new Error(`unexpected action: ${request.action}`);
    });
    const ctx = callbackCtx("integration:rd:d:connect:dev-1");

    await handleRustDeskSettingsCallback(ctx);

    const calls = (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mock.calls;
    const rendered = calls.map((call) => String(call[2] ?? "")).join("\n");
    expect(rendered).toContain("connected");
    expect(rendered).toContain("conn-saved-1");
    expect(rendered).not.toContain("unknown");
    expect(rendered).not.toContain("Online: Unknown");
  });

  it("treats Telegram message-not-modified as an idempotent panel refresh", async () => {
    mocks.execute.mockImplementation(async (request: { action: string }) => {
      if (request.action === "devices.get") {
        return {
          ok: true,
          device: {
            id: "dev-1",
            name: "Phone",
            rustdeskId: "123456789",
            serverProfileId: "rustdesk-public",
            credentialConfigured: true,
          },
        };
      }
      throw new Error(`unexpected action: ${request.action}`);
    });
    const ctx = callbackCtx("integration:rd:d:view:dev-1");
    (ctx.api.editMessageText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("400: Bad Request: message is not modified"),
    );

    await expect(handleRustDeskSettingsCallback(ctx)).resolves.toBe(true);
  });

  it("renders wizard errors into the canonical panel instead of replying with a new message", async () => {
    mocks.upsertDevice.mockRejectedValueOnce(new Error("Bridge rejected credential"));
    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:d:add"));
    await handleRustDeskSettingsMessage(messageCtx("My PC", 401));
    await handleRustDeskSettingsMessage(messageCtx("123456789", 402));
    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:w:server:rustdesk-public"));
    await handleRustDeskSettingsCallback(callbackCtx("integration:rd:w:relay:no"));
    const secretCtx = messageCtx("bad-secret", 403);

    await handleRustDeskSettingsMessage(secretCtx);

    expect(secretCtx.api.editMessageText).toHaveBeenCalledWith(
      42,
      777,
      expect.stringContaining("Bridge rejected credential"),
      expect.any(Object),
    );
    expect(secretCtx.reply).not.toHaveBeenCalled();
  });
});

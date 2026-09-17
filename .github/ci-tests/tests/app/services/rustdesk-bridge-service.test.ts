import { describe, expect, it, vi } from "vitest";

import {
  RustDeskBridgeClient,
  validateRustDeskActionRequest,
} from "../../../src/app/services/rustdesk-bridge-service.js";

describe("rustdesk bridge service", () => {
  it("allows device discovery without a device id", () => {
    expect(() => validateRustDeskActionRequest({ action: "devices.list" })).not.toThrow();
  });

  it("requires a device id for device-scoped actions", () => {
    expect(() =>
      validateRustDeskActionRequest({
        action: "terminal.exec",
        command: "uname -a",
      }),
    ).toThrow("terminal.exec requires deviceId");
  });

  it("requires action-specific terminal arguments", () => {
    expect(() =>
      validateRustDeskActionRequest({
        action: "terminal.exec",
        deviceId: "server-1",
      }),
    ).toThrow("terminal.exec requires command");

    expect(() =>
      validateRustDeskActionRequest({
        action: "terminal.read",
        deviceId: "server-1",
      }),
    ).toThrow("terminal.read requires sessionId");
  });

  it("requires coordinates for GUI pointer actions", () => {
    expect(() =>
      validateRustDeskActionRequest({
        action: "mouse.click",
        deviceId: "pc-1",
        x: 100,
      }),
    ).toThrow("mouse.click requires a finite y");
  });

  it("requires authentication for non-loopback bridges", () => {
    expect(() => new RustDeskBridgeClient({ baseUrl: "https://bridge.example.com" })).toThrow(
      "RUSTDESK_BRIDGE_TOKEN is required",
    );
  });

  it("requires https for a non-loopback bridge even when a token is supplied", () => {
    expect(() =>
      new RustDeskBridgeClient({
        baseUrl: "http://bridge.example.com",
        token: "secret-token",
      }),
    ).toThrow("Remote RustDesk bridges must use https");
  });

  it("allows an IPv6 loopback bridge without a token", () => {
    expect(() => new RustDeskBridgeClient({ baseUrl: "http://[::1]:21119" })).not.toThrow();
  });

  it("sends an authenticated action request to the bridge", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          devices: [
            {
              id: "ubuntu-1",
              os: { family: "linux", name: "Ubuntu", version: "24.04" },
              capabilities: { terminal: true, screen: false },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com/",
      token: "secret-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await client.execute({ action: "devices.list" });

    expect(result).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example.com/v1/action",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
  });

  it("surfaces structured bridge errors without leaking credentials", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "device is offline" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "secret-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.execute({ action: "system.info", deviceId: "offline-pc" }),
    ).rejects.toThrow("RustDesk bridge HTTP 409: device is offline");
  });
});

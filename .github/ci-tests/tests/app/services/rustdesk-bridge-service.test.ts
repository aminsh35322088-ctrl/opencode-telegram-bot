import { describe, expect, it, vi } from "vitest";

import {
  RustDeskBridgeClient,
  type RustDeskActionRequest,
  validateRustDeskActionRequest,
} from "../../../src/app/services/rustdesk-bridge-service.js";

describe("rustdesk bridge service", () => {
  it("allows bridge, server, and device discovery without connection identifiers", () => {
    expect(() => validateRustDeskActionRequest({ action: "bridge.health" })).not.toThrow();
    expect(() => validateRustDeskActionRequest({ action: "servers.list" })).not.toThrow();
    expect(() => validateRustDeskActionRequest({ action: "devices.list" })).not.toThrow();
  });

  it("requires a connection id for connection-scoped actions", () => {
    expect(() =>
      validateRustDeskActionRequest({
        action: "terminal.exec",
        command: "uname -a",
      }),
    ).toThrow("terminal.exec requires connectionId");
  });

  it("requires action-specific terminal arguments", () => {
    expect(() =>
      validateRustDeskActionRequest({
        action: "terminal.exec",
        connectionId: "conn-1",
      }),
    ).toThrow("terminal.exec requires command");

    expect(() =>
      validateRustDeskActionRequest({
        action: "terminal.read",
        connectionId: "conn-1",
      }),
    ).toThrow("terminal.read requires terminalId");

    expect(() =>
      validateRustDeskActionRequest({
        action: "terminal.resize",
        connectionId: "conn-1",
        terminalId: "term-1",
        rows: 24,
      }),
    ).toThrow("terminal.resize requires a finite cols");
  });

  it("keeps saved-device connection routing and auth immutable", () => {
    expect(() =>
      validateRustDeskActionRequest({ action: "devices.connect", deviceId: "home-pc" }),
    ).not.toThrow();

    expect(() =>
      validateRustDeskActionRequest({
        action: "devices.connect",
        deviceId: "home-pc",
        server: { kind: "public" },
      }),
    ).toThrow("does not accept overrides");
  });

  it("validates temporary connection identity, server, and auth mode", () => {
    expect(() =>
      validateRustDeskActionRequest({
        action: "session.connectTemporary",
        rustdeskId: "123456789",
        server: { kind: "public" },
        authMode: "manual-approval",
      }),
    ).not.toThrow();

    expect(() =>
      validateRustDeskActionRequest({
        action: "session.connectTemporary",
        rustdeskId: "123456789",
        authMode: "manual-approval",
      }),
    ).toThrow("session.connectTemporary requires server selection");
  });

  it("rejects secret fields from model-originated requests", () => {
    const request = {
      action: "session.connectTemporary",
      rustdeskId: "123456789",
      server: { kind: "public" },
      authMode: "temporary-password",
      password: "must-not-enter-model-context",
    } as unknown as RustDeskActionRequest;

    expect(() => validateRustDeskActionRequest(request)).toThrow(
      "RustDesk model actions cannot carry secret field args.password",
    );
  });

  it("requires coordinates for GUI pointer actions", () => {
    expect(() =>
      validateRustDeskActionRequest({
        action: "mouse.click",
        connectionId: "conn-1",
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
      client.execute({ action: "system.info", connectionId: "conn-offline" }),
    ).rejects.toThrow("RustDesk bridge HTTP 409: device is offline");
  });
});

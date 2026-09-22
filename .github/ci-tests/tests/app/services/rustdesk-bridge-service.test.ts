import { describe, expect, it, vi } from "vitest";

import {
  RustDeskBridgeClient,
  RustDeskBridgeHttpError,
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


  it("preserves structured permission-required bridge errors", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "approval required",
          errorCode: "permission_required",
          risk: "mutating",
          permission: "ask",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "action-fixture",
      controlToken: "control-fixture",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    try {
      await client.execute({
        action: "terminal.exec",
        connectionId: "conn-1",
        command: "uname -a",
      });
      throw new Error("expected structured bridge error");
    } catch (error) {
      expect(error).toBeInstanceOf(RustDeskBridgeHttpError);
      const bridgeError = error as RustDeskBridgeHttpError;
      expect(bridgeError.status).toBe(403);
      expect(bridgeError.errorCode).toBe("permission_required");
      expect(bridgeError.payload).toMatchObject({ risk: "mutating", permission: "ask" });
    }
  });

  it("uses the separate control token for permission grants", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          permissionGrantId: "perm-1",
          action: "terminal.exec",
          scope: "once",
          expiresInSeconds: 300,
          risk: "mutating",
          permission: "ask",
          idempotent: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "action-fixture",
      controlToken: "control-fixture",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await client.grantPermission({
      action: "terminal.exec",
      connectionId: "conn-1",
      scope: "once",
    });

    expect(result.permissionGrantId).toBe("perm-1");
    expect(result.idempotent).toBe(true);
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://bridge.example.com/v1/permission");
    expect((request?.[1] as RequestInit | undefined)?.method).toBe("POST");
    expect((request?.[1] as RequestInit | undefined)?.body).toBe(
      JSON.stringify({ action: "terminal.exec", connectionId: "conn-1", scope: "once" }),
    );
  });

  it("validates the credential control-plane response and preserves idempotency metadata", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          connectionId: "conn-1",
          credentialRequestId: "credreq-1",
          status: "connecting",
          accepted: true,
          idempotent: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "action-fixture",
      controlToken: "control-fixture",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await client.submitCredential({
      credentialRequestId: "credreq-1",
      credential: "fixture-secret",
      trustThisDevice: false,
    });

    expect(result).toMatchObject({
      ok: true,
      connectionId: "conn-1",
      credentialRequestId: "credreq-1",
      accepted: true,
      idempotent: true,
    });
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://bridge.example.com/v1/credential");
    expect((request?.[1] as RequestInit | undefined)?.body).toBe(
      JSON.stringify({
        credentialRequestId: "credreq-1",
        credential: "fixture-secret",
        trustThisDevice: false,
      }),
    );
  });

  it("asks for approval, mints a one-shot grant, and retries the action", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: "approval required",
            errorCode: "permission_required",
            risk: "mutating",
            permission: "ask",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, permissionGrantId: "perm-1", scope: "once" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, output: "Linux" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "action-fixture",
      controlToken: "control-fixture",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const authorize = vi.fn(async () => {});

    const result = await client.executeAuthorized(
      { action: "terminal.exec", connectionId: "conn-1", command: "uname -a" },
      authorize,
    );

    expect(result).toMatchObject({ ok: true, output: "Linux" });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "terminal.exec",
        connectionId: "conn-1",
        risk: "mutating",
        permission: "ask",
      }),
    );
    const retry = fetchMock.mock.calls[2];
    const retryBody = JSON.parse(String((retry?.[1] as RequestInit | undefined)?.body));
    expect(retryBody.permissionGrantId).toBe("perm-1");
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

describe("rustdesk bridge secure inventory control", () => {
  it("uses the control token for server-profile upsert without sending it to the action endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, server: { id: "lab", name: "Lab", kind: "custom" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "action-fixture",
      controlToken: "control-fixture",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.upsertServerProfile({
      id: "lab",
      name: "Lab",
      idServer: "rd.example.test",
      relayServer: "relay.example.test",
      serverKey: "private-key-material",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example.com/v1/control/server-profiles/upsert",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer control-fixture" }),
      }),
    );
  });

  it("uses the control plane for RustDesk Public login status and provider start", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            account: {
              loggedIn: false,
              state: "Waiting account auth",
              authUrl: "https://github.com/login/oauth/authorize?fixture=1",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            account: {
              loggedIn: false,
              state: "Waiting account auth",
              authUrl: "https://github.com/login/oauth/authorize?fixture=2",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "action-fixture",
      controlToken: "control-fixture",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const status = await client.getPublicAccountStatus();
    const started = await client.startPublicAccountLogin("github");

    expect(status.loggedIn).toBe(false);
    expect(started.authUrl).toContain("https://github.com/login/oauth/authorize");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://bridge.example.com/v1/control/public-account/status",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://bridge.example.com/v1/control/public-account/login",
    );
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body).toBe(
      JSON.stringify({ provider: "github" }),
    );
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.headers).toMatchObject({
        Authorization: "Bearer control-fixture",
      });
    }
  });

  it("rejects malformed Public account responses", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, account: { state: "missing loggedIn" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "action-fixture",
      controlToken: "control-fixture",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.getPublicAccountStatus()).rejects.toThrow(
      "public account status without loggedIn",
    );
  });

  it("keeps one-time custom server keys on the Settings control plane", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, connection: { connectionId: "conn-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "action-fixture",
      controlToken: "control-fixture",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.connectTemporaryFromSettings({
      rustdeskId: "987654321",
      authMode: "manual-approval",
      server: { kind: "one-time-custom", idServer: "id.example.test" },
      serverKey: "private-server-key",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example.com/v1/control/session/connect-temporary",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer control-fixture" }),
        body: expect.stringContaining("private-server-key"),
      }),
    );
  });

  it("uses the control token for permanent-device upsert and delete", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, device: { id: "desktop-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, deleted: "desktop-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const client = new RustDeskBridgeClient({
      baseUrl: "https://bridge.example.com",
      token: "action-fixture",
      controlToken: "control-fixture",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.upsertDevice({
      id: "desktop-1",
      name: "Desktop",
      rustdeskId: "123456789",
      serverProfileId: "rustdesk-public",
      credential: "permanent-password",
    });
    await client.deleteDevice("desktop-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://bridge.example.com/v1/control/devices/upsert",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://bridge.example.com/v1/control/devices/delete",
    );
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.headers).toMatchObject({
        Authorization: "Bearer control-fixture",
      });
    }
  });
});

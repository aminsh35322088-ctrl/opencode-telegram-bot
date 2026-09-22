import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import rustdeskTool from "../../.opencode/tools/rustdesk.ts";
import { RUSTDESK_ACTIONS } from "../../src/app/services/rustdesk-bridge-service.js";

type BridgeClientMock = {
  execute: ReturnType<typeof vi.fn>;
};

function installBridgeClient(
  client: BridgeClientMock,
  consumePermissionHandoff: ReturnType<typeof vi.fn>,
): void {
  (
    globalThis as typeof globalThis & {
      __rustdeskBridgeClient?: BridgeClientMock;
      __rustdeskConsumePermissionHandoff?: ReturnType<typeof vi.fn>;
    }
  ).__rustdeskBridgeClient = client;
  (
    globalThis as typeof globalThis & {
      __rustdeskConsumePermissionHandoff?: ReturnType<typeof vi.fn>;
    }
  ).__rustdeskConsumePermissionHandoff = consumePermissionHandoff;
  process.env.RUSTDESK_BRIDGE_SERVICE_PATH = path.resolve(
    "tests/fixtures/rustdesk-bridge-client-fixture.mjs",
  );
}

afterEach(() => {
  delete (
    globalThis as typeof globalThis & {
      __rustdeskBridgeClient?: BridgeClientMock;
      __rustdeskConsumePermissionHandoff?: ReturnType<typeof vi.fn>;
    }
  ).__rustdeskBridgeClient;
  delete (
    globalThis as typeof globalThis & {
      __rustdeskConsumePermissionHandoff?: ReturnType<typeof vi.fn>;
    }
  ).__rustdeskConsumePermissionHandoff;
  delete process.env.RUSTDESK_BRIDGE_SERVICE_PATH;
  vi.restoreAllMocks();
});

describe("OpenCode RustDesk tool v4 contract", () => {
  it("exposes the exact Bot 36-action surface and no control-plane secret path", () => {
    const source = fs.readFileSync(".opencode/tools/rustdesk.ts", "utf8");
    const match = source.match(/"Action: ([^"]+)\."/);
    expect(match?.[1]).toBeTruthy();
    const toolActions = match![1].split(",").map((value) => value.trim());

    expect(toolActions).toEqual([...RUSTDESK_ACTIONS]);
    expect(toolActions).toHaveLength(36);
    expect(source).not.toContain("RUSTDESK_BRIDGE_CONTROL_TOKEN");
    expect(source).not.toContain("client.grantPermission");
    expect(source).not.toMatch(/permissionGrantId\s*=\s*["']perm_/);
  });

  it("asks OpenCode, consumes the trusted Bot handoff, and retries in the same sessionScope", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("permission required"), {
          errorCode: "permission_required",
          payload: { risk: "mutating", permission: "ask" },
        }),
      )
      .mockResolvedValueOnce({ ok: true, output: "Linux" });
    const consumePermissionHandoff = vi.fn().mockResolvedValue({
      permissionGrantId: "perm_real_from_bridge",
    });
    installBridgeClient({ execute }, consumePermissionHandoff);

    const ask = vi.fn().mockResolvedValue(undefined);
    const metadata = vi.fn();
    const abortController = new AbortController();

    const result = await (rustdeskTool as {
      execute(args: Record<string, unknown>, context: Record<string, unknown>): Promise<string>;
    }).execute(
      {
        action: "terminal.exec",
        connection_id: "conn-1",
        command: "uname -a",
      },
      {
        sessionID: "topic-session-123",
        directory: process.cwd(),
        worktree: process.cwd(),
        abort: abortController.signal,
        ask,
        metadata,
      },
    );

    expect(ask).toHaveBeenCalledOnce();
    const askInput = ask.mock.calls[0]?.[0] as {
      metadata?: { rustdeskApprovalCorrelationId?: unknown };
    };
    const correlationId = askInput.metadata?.rustdeskApprovalCorrelationId;
    expect(correlationId).toEqual(expect.stringMatching(/^[a-f0-9]{48}$/));

    expect(consumePermissionHandoff).toHaveBeenCalledWith({
      correlationId,
      action: "terminal.exec",
      connectionId: "conn-1",
      sessionScope: "topic-session-123",
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      action: "terminal.exec",
      connectionId: "conn-1",
      sessionScope: "topic-session-123",
    });
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      action: "terminal.exec",
      connectionId: "conn-1",
      sessionScope: "topic-session-123",
      permissionGrantId: "perm_real_from_bridge",
    });
    expect(result).toContain('"ok": true');
  });
});

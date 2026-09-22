import { beforeEach, describe, expect, it } from "vitest";
import { rustDeskSessionPermissionManager } from "../../../src/app/managers/rustdesk-session-permission-manager.js";

describe("RustDesk session permission manager", () => {
  beforeEach(() => rustDeskSessionPermissionManager.__resetForTests());

  it("keeps a pending Always Allow lease from authorizing a second connection creation", () => {
    rustDeskSessionPermissionManager.grant(777, "session-a");

    expect(rustDeskSessionPermissionManager.has(777, "session-a")).toBe(true);
    expect(rustDeskSessionPermissionManager.canUse(777, "session-a")).toBe(false);
    expect(rustDeskSessionPermissionManager.canUse(777, "session-a", "conn-1")).toBe(true);
  });

  it("binds the first concrete connection and rejects cross-connection reuse", () => {
    rustDeskSessionPermissionManager.grant(777, "session-a");
    expect(rustDeskSessionPermissionManager.bindConnection(777, "session-a", "conn-1")).toBe(true);

    expect(rustDeskSessionPermissionManager.canUse(777, "session-a", "conn-1")).toBe(true);
    expect(rustDeskSessionPermissionManager.canUse(777, "session-a", "conn-2")).toBe(false);
  });

  it("revokes a lease on disconnect and isolates chats and sessions", () => {
    rustDeskSessionPermissionManager.grant(777, "session-a", "conn-1");
    rustDeskSessionPermissionManager.grant(888, "session-a", "conn-2");

    expect(rustDeskSessionPermissionManager.revoke(777, "session-a", "conn-1")).toBe(true);
    expect(rustDeskSessionPermissionManager.has(777, "session-a")).toBe(false);
    expect(rustDeskSessionPermissionManager.has(888, "session-a")).toBe(true);
  });

  it("expires an unbound lease if no RustDesk connection materializes", () => {
    rustDeskSessionPermissionManager.grant(777, "session-a");
    const afterPendingTtl = Date.now() + 16 * 60 * 1000;

    expect(
      rustDeskSessionPermissionManager.canUse(777, "session-a", "conn-1", afterPendingTtl),
    ).toBe(false);
    expect(rustDeskSessionPermissionManager.has(777, "session-a")).toBe(false);
  });
});

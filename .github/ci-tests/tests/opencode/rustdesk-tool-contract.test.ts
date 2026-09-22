import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUSTDESK_ACTIONS } from "../../src/app/services/rustdesk-bridge-service.js";

describe("RustDesk OpenCode tool contract", () => {
  it("matches the Bot action surface exactly and uses the real Bridge permission flow", async () => {
    const source = await fs.readFile(".opencode/tools/rustdesk.ts", "utf8");
    const actionText = source.match(/"Action: ([^"]+)\."/u)?.[1];
    expect(actionText).toBeTruthy();

    const toolActions = actionText!.split(", ").map((action) => action.trim());
    expect(toolActions).toEqual([...RUSTDESK_ACTIONS]);
    expect(toolActions).toHaveLength(36);
    expect(toolActions).toContain("connections.list");

    expect(source).toContain("sessionScope: context.sessionID");
    expect(source).toContain("consumeRustDeskPermissionGrantHandoff({");
    expect(source).not.toContain("RUSTDESK_BRIDGE_CONTROL_TOKEN");
    expect(source).not.toContain("client.grantPermission({");
    expect(source).toContain("sessionScope: context.sessionID,");
    expect(source).toContain("permissionGrantId: grant.permissionGrantId");
    expect(source).not.toContain("randomUUID");
    expect(source).not.toContain("perm_${");

    const ask = source.indexOf("await context.ask({");
    const grant = source.indexOf("consumeRustDeskPermissionGrantHandoff({");
    const retry = source.indexOf("permissionGrantId: grant.permissionGrantId");
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(ask);
    expect(retry).toBeGreaterThan(grant);
  });

  it("scopes credential polling to the current OpenCode session", async () => {
    const source = await fs.readFile(".opencode/tools/rustdesk.ts", "utf8");
    expect(source).toMatch(/action: "connection\.status",[\s\S]*sessionScope: context\.sessionID/u);
  });
});

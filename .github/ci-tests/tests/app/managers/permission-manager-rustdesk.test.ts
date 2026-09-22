import { beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "../../../src/app/types/permission.js";
import { permissionManager } from "../../../src/app/managers/permission-manager.js";

function rustDeskRequest(id: string, legacyGrantId: string): PermissionRequest {
  return {
    id,
    sessionID: "session-topic-a",
    permission: "rustdesk.terminal.exec",
    patterns: ["terminal.exec:conn-1"],
    metadata: {
      source: "rustdesk",
      action: "terminal.exec",
      permissionGrantId: legacyGrantId,
    },
    always: [],
  };
}

describe("permission manager RustDesk grouping", () => {
  beforeEach(() => permissionManager.clear());

  it("ignores obsolete RustDesk grant metadata when grouping equivalent OpenCode prompts", () => {
    expect(permissionManager.startPermission(rustDeskRequest("request-1", "legacy-a"), 100)).toBe(true);

    expect(permissionManager.addEquivalentRequest(rustDeskRequest("request-2", "legacy-b"))).toMatchObject({
      messageId: 100,
      count: 2,
    });
    expect(permissionManager.getRequestIDs(100)).toEqual(["request-1", "request-2"]);
  });
});

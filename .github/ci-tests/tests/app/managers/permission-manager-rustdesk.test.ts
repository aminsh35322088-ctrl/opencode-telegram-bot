import { beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "../../../src/app/types/permission.js";
import { permissionManager } from "../../../src/app/managers/permission-manager.js";

function rustDeskRequest(id: string, approvalCorrelationId: string): PermissionRequest {
  return {
    id,
    sessionID: "session-topic-a",
    permission: "rustdesk.terminal.exec",
    patterns: ["terminal.exec:conn-1"],
    metadata: {
      source: "rustdesk",
      action: "terminal.exec",
      connectionId: "conn-1",
      rustdeskApprovalCorrelationId: approvalCorrelationId,
    },
    always: [],
  };
}

describe("permission manager RustDesk grouping", () => {
  beforeEach(() => permissionManager.clear());

  it("retains every grouped RustDesk request metadata for trusted approval handoff", () => {
    expect(permissionManager.startPermission(rustDeskRequest("request-1", "a".repeat(48)), 100)).toBe(true);

    expect(permissionManager.addEquivalentRequest(rustDeskRequest("request-2", "b".repeat(48)))).toMatchObject({
      messageId: 100,
      count: 2,
    });
    expect(permissionManager.getRequestIDs(100)).toEqual(["request-1", "request-2"]);
    expect(
      permissionManager
        .getRequests(100)
        .map((request) => request.metadata.rustdeskApprovalCorrelationId),
    ).toEqual(["a".repeat(48), "b".repeat(48)]);
  });
});

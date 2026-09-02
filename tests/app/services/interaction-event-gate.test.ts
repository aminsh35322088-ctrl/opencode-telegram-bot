import { describe, expect, it } from "vitest";
import { InteractionEventGate } from "../../../src/app/services/interaction-event-gate.js";

describe("InteractionEventGate", () => {
  it("blocks only the session with a pending interaction", () => {
    const gate = new InteractionEventGate();

    gate.mark("permission", "session-a", "perm-1");

    expect(gate.isBlocked("session-a")).toBe(true);
    expect(gate.isBlocked("session-b")).toBe(false);
    expect(gate.getPendingCount("permission", "session-a")).toBe(1);
  });

  it("keeps a session blocked until every request is released", () => {
    const gate = new InteractionEventGate();

    gate.mark("permission", "session-a", "perm-1");
    gate.mark("permission", "session-a", "perm-2");
    gate.release("permission", "session-a", "perm-1");

    expect(gate.isBlocked("session-a")).toBe(true);
    expect(gate.getPendingCount("permission", "session-a")).toBe(1);

    gate.release("permission", "session-a", "perm-2");
    expect(gate.isBlocked("session-a")).toBe(false);
  });

  it("combines permission and question barriers", () => {
    const gate = new InteractionEventGate();

    gate.mark("question", "session-a", "question-1");
    expect(gate.isBlocked("session-a")).toBe(true);

    gate.release("question", "session-a", "question-1");
    gate.mark("permission", "session-a", "perm-1");
    expect(gate.isBlocked("session-a")).toBe(true);

    gate.clearSession("session-a");
    expect(gate.isBlocked("session-a")).toBe(false);
  });
});

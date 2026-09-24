import { describe, expect, it } from "vitest";
import {
  createRunId,
  LIFECYCLE_OPERATIONS,
  normalizeTopicDirectory,
  type OutboundEnvelope,
  type TopicEnvelope,
  validateOutboundEnvelope,
  validateTopicEnvelope,
} from "../../../src/app/services/topic-worker-protocol.js";

function makeEnvelope(overrides: Partial<TopicEnvelope> = {}): TopicEnvelope {
  return {
    bindingId: "binding-a",
    chatId: 100,
    threadId: 11,
    sessionId: "session-a",
    directory: "/workspace",
    bindingGeneration: 1,
    runId: "run-1",
    operation: "prompt.dispatch",
    operationId: "operation-1",
    payload: {},
    ...overrides,
  };
}

function makeOutbound(overrides: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    bindingId: "binding-a",
    chatId: 100,
    threadId: 11,
    sessionId: "session-a",
    directory: "/workspace",
    bindingGeneration: 1,
    runId: "run-1",
    kind: "assistant.message",
    operationId: "operation-1",
    payload: {},
    ...overrides,
  };
}

describe("topic worker protocol", () => {
  it("rejects a stale bindingGeneration", () => {
    const envelope = makeEnvelope({ bindingGeneration: 3 });
    expect(validateTopicEnvelope(envelope, { bindingGeneration: 4, runId: "run-4" })).toEqual({
      accepted: false,
      reason: "stale_binding_generation",
    });
  });

  it("rejects a stale runId", () => {
    const envelope = makeEnvelope({ runId: "run-old" });
    expect(validateTopicEnvelope(envelope, { bindingGeneration: 3, runId: "run-current" })).toEqual({
      accepted: false,
      reason: "stale_run",
    });
  });

  it("allows a null runId only for a lifecycle operation", () => {
    expect(validateTopicEnvelope(
      makeEnvelope({ operation: "session.heartbeat", runId: null }),
      { bindingGeneration: 3, runId: "run-current" },
    )).toEqual({ accepted: true, reason: null });
  });

  it("accepts a matching model-capable envelope", () => {
    expect(validateTopicEnvelope(makeEnvelope(), { bindingGeneration: 1, runId: "run-1" })).toEqual({
      accepted: true,
      reason: null,
    });
  });

  it.each([
    [{ bindingId: "" }, "missing_binding"],
    [{ threadId: 0 }, "invalid_route"],
    [{ chatId: 0 }, "invalid_route"],
    [{ operationId: "" }, "invalid_route"],
    [{ bindingGeneration: 0 }, "invalid_route"],
    [{ runId: "" }, "invalid_run_id"],
    [{ operation: "prompt.dispatch", runId: null }, "invalid_run_id"],
  ] as const)("rejects an invalid envelope %j", (overrides, reason) => {
    expect(validateTopicEnvelope(makeEnvelope(overrides), { bindingGeneration: 1, runId: "run-1" })).toEqual({
      accepted: false,
      reason,
    });
  });

  it("validates outbound generation and run identity", () => {
    expect(validateOutboundEnvelope(makeOutbound({ bindingGeneration: 2 }), { bindingGeneration: 3, runId: "run-1" })).toEqual({
      accepted: false,
      reason: "stale_binding_generation",
    });
    expect(validateOutboundEnvelope(makeOutbound({ runId: "run-old" }), { bindingGeneration: 1, runId: "run-1" })).toEqual({
      accepted: false,
      reason: "stale_run",
    });
    expect(validateOutboundEnvelope(makeOutbound(), { bindingGeneration: 1, runId: "run-1" })).toEqual({
      accepted: true,
      reason: null,
    });
  });

  it("rejects an empty outbound runId", () => {
    expect(validateOutboundEnvelope(makeOutbound({ runId: "" }), { bindingGeneration: 1, runId: "run-1" })).toEqual({
      accepted: false,
      reason: "invalid_run_id",
    });
  });

  it("exposes the explicit lifecycle operation set", () => {
    expect([...LIFECYCLE_OPERATIONS]).toEqual([
      "session.heartbeat",
      "session.status",
      "session.idle",
      "session.error",
    ]);
  });

  it("normalizes directory case, separators, and trailing slashes", () => {
    expect(normalizeTopicDirectory("  C:\\Work\\Project\\\\  ")).toBe("c:/work/project");
  });

  it("creates non-empty unique run IDs", () => {
    const first = createRunId();
    const second = createRunId();
    expect(first).not.toBe("");
    expect(second).not.toBe("");
    expect(first).not.toBe(second);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getCancellationErrorSuppressionSizeForTests,
  __resetCancellationErrorSuppressionForTests,
  markCancellationExpected,
  shouldSuppressExpectedCancellationError,
} from "../../../src/app/managers/cancellation-suppression-manager.js";

describe("app/managers/cancellation-suppression-manager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T10:00:00Z"));
    __resetCancellationErrorSuppressionForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetCancellationErrorSuppressionForTests();
  });

  it("suppresses exactly one expected Aborted error", () => {
    markCancellationExpected("session-1");
    expect(shouldSuppressExpectedCancellationError("session-1", " Aborted ")).toBe(true);
    expect(shouldSuppressExpectedCancellationError("session-1", "Aborted")).toBe(false);
  });

  it("does not consume the marker for an unrelated error", () => {
    markCancellationExpected("session-1");
    expect(shouldSuppressExpectedCancellationError("session-1", "Model not found")).toBe(false);
    expect(shouldSuppressExpectedCancellationError("session-1", "Aborted")).toBe(true);
  });

  it("does not suppress stale cancellation errors", () => {
    markCancellationExpected("session-1");
    vi.advanceTimersByTime(90_001);
    expect(shouldSuppressExpectedCancellationError("session-1", "Aborted")).toBe(false);
  });

  it("keeps cancellation markers active within the suppression window", () => {
    markCancellationExpected("session-1");
    vi.advanceTimersByTime(89_999);
    expect(shouldSuppressExpectedCancellationError("session-1", "Aborted")).toBe(true);
  });

  it("expires old markers when a new cancellation is marked", () => {
    markCancellationExpected("session-1");
    vi.advanceTimersByTime(90_001);
    markCancellationExpected("session-2");
    expect(__getCancellationErrorSuppressionSizeForTests()).toBe(1);
    expect(shouldSuppressExpectedCancellationError("session-1", "Aborted")).toBe(false);
    expect(shouldSuppressExpectedCancellationError("session-2", "Aborted")).toBe(true);
  });

  it("scopes expected cancellation to the exact session", () => {
    markCancellationExpected("session-a");
    expect(shouldSuppressExpectedCancellationError("session-b", "Aborted")).toBe(false);
    expect(shouldSuppressExpectedCancellationError("session-a", "Aborted")).toBe(true);
  });
});

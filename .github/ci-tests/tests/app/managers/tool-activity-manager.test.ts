import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  markToolCallStarted,
  markToolCallFinished,
  hasActiveToolCall,
  clearToolActivity,
  clearAllToolActivity,
} from "../../../src/app/managers/tool-activity-manager.js";

describe("tool-activity-manager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    clearAllToolActivity();
    vi.useRealTimers();
  });

  it("tracks active calls per session and clears them on finish", () => {
    markToolCallStarted("s1", "c1");
    markToolCallStarted("s1", "c2");
    markToolCallStarted("s2", "c3");
    expect(hasActiveToolCall("s1")).toBe(true);
    expect(hasActiveToolCall("s2")).toBe(true);

    markToolCallFinished("s1", "c1");
    expect(hasActiveToolCall("s1")).toBe(true);
    markToolCallFinished("s1", "c2");
    expect(hasActiveToolCall("s1")).toBe(false);
  });

  it("ignores terminal marks for unknown ids and empty ids", () => {
    markToolCallStarted("", "c1");
    markToolCallStarted("s1", "");
    expect(hasActiveToolCall("s1")).toBe(false);
    markToolCallFinished("missing", "c1");
    expect(hasActiveToolCall("missing")).toBe(false);
  });

  it("drops entries that never received a terminal event after the stale window", () => {
    markToolCallStarted("s1", "c1");
    vi.advanceTimersByTime(31 * 60_000);
    expect(hasActiveToolCall("s1")).toBe(false);
  });

  it("clears per-session and globally", () => {
    markToolCallStarted("s1", "c1");
    markToolCallStarted("s2", "c2");
    clearToolActivity("s1");
    expect(hasActiveToolCall("s1")).toBe(false);
    expect(hasActiveToolCall("s2")).toBe(true);
    clearAllToolActivity();
    expect(hasActiveToolCall("s2")).toBe(false);
  });
});

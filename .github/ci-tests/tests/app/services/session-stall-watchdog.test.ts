import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), messages: vi.fn(), abort: vi.fn() }));
vi.mock("../../../src/opencode/client.js", () => ({ opencodeClient: { session: mocks } }));
import { startSessionStallWatchdog as start, stopSessionStallWatchdog as stop, __resetSessionStallWatchdogsForTests as reset } from "../../../src/app/services/session-stall-watchdog.js";
import { markToolCallStarted, markToolCallFinished } from "../../../src/app/managers/tool-activity-manager.js";

const options = (sessionId: string, onStalled = vi.fn()) => ({ sessionId, directory: `/workspace/${sessionId}`, model: "test/model", onStalled });

describe("watchdog liveness and isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.status.mockReset();
    mocks.messages.mockReset();
    mocks.abort.mockReset();
    mocks.status.mockResolvedValue({ data: { a: { type: "busy" }, b: { type: "busy" } } });
    mocks.messages.mockResolvedValue({ data: [] });
    mocks.abort.mockResolvedValue({ data: true });
  });
  afterEach(() => { reset(); vi.useRealTimers(); });

  it("keeps monitoring after a transient status failure", async () => {
    mocks.status.mockResolvedValueOnce({ error: new Error("temporary outage") });
    start(options("a"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(mocks.messages).toHaveBeenCalledTimes(1);
  });

  it("does not let an old loop remove a replacement watchdog", async () => {
    start(options("a")); stop("a"); start(options("a"));
    await vi.advanceTimersByTimeAsync(5000);
    stop("a");
    const count = mocks.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.status).toHaveBeenCalledTimes(count);
  });

  it("does not continue a stopped probe into messages or recovery", async () => {
    let release!: (result: unknown) => void;
    mocks.status.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    start(options("a"));
    await vi.advanceTimersByTimeAsync(5000);
    stop("a");
    release({ data: { a: { type: "busy" } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.messages).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  it("does not abort a session while OpenCode is handling a provider retry", async () => {
    mocks.status.mockResolvedValue({ data: { a: { type: "retry" } } });
    const onStalled = vi.fn();
    start(options("a", onStalled));

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(mocks.messages).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(onStalled).not.toHaveBeenCalled();
  });

  it("does not abort a session while a tool call is active past the stall threshold", async () => {
    markToolCallStarted("a", "call-1");
    start(options("a"));
    await vi.advanceTimersByTimeAsync(250_000);
    expect(mocks.abort).not.toHaveBeenCalled();

    markToolCallFinished("a", "call-1");
    await vi.advanceTimersByTimeAsync(250_000);
    expect(mocks.abort.mock.calls.some((call) => call[0].sessionID === "a")).toBe(true);
  });

  it("bounds a hanging status probe and lets another Topic continue", async () => {
    mocks.status.mockImplementationOnce(() => new Promise(() => {}));
    start(options("a")); start(options("b"));
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.status.mock.calls.filter(call => call[0].directory === "/workspace/a").length).toBeGreaterThan(1);
    expect(mocks.status.mock.calls.filter(call => call[0].directory === "/workspace/b").length).toBeGreaterThan(1);
  });
});

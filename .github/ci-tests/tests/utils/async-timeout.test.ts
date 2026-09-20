import { describe, expect, it } from "vitest";

import { TimeoutError, isTimeoutError, withTimeout } from "../../../src/utils/async-timeout.js";

describe("withTimeout", () => {
  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "fast")).resolves.toBe("ok");
  });

  it("rejects with a TimeoutError when the promise never settles", async () => {
    const pending = new Promise<string>(() => {});
    await expect(withTimeout(pending, 10, "stuck-bot-api-call")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("labels the timeout with the operation name", async () => {
    const pending = new Promise<string>(() => {});
    const error = await withTimeout(pending, 10, "stuck-bot-api-call").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(String((error as Error).message)).toContain("stuck-bot-api-call");
  });

  it("propagates the original rejection when the promise fails first", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "failing")).rejects.toThrow("boom");
  });

  it("detects timeout errors with isTimeoutError", () => {
    expect(isTimeoutError(new TimeoutError("x"))).toBe(true);
    expect(isTimeoutError(new Error("x"))).toBe(false);
    expect(isTimeoutError("x")).toBe(false);
  });
});
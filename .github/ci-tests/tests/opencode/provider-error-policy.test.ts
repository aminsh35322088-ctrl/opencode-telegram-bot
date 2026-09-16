import { describe, expect, it } from "vitest";
import { isDeterministicProviderRetryError } from "../../src/opencode/provider-error-policy.js";

describe("opencode/provider-error-policy", () => {
  it("keeps existing deterministic quota errors non-retryable", () => {
    expect(isDeterministicProviderRetryError("prompt is longer than the free tier allows for a single request")).toBe(true);
    expect(isDeterministicProviderRetryError("insufficient balance")).toBe(true);
  });

  it("classifies context-window overflow as deterministic", () => {
    expect(isDeterministicProviderRetryError(
      "The request is invalid: Input tokens exceed the configured limit of 192000 tokens. Your messages resulted in 556328 tokens.",
    )).toBe(true);
    expect(isDeterministicProviderRetryError("maximum context length is 128000 tokens")).toBe(true);
    expect(isDeterministicProviderRetryError("context length exceeded")).toBe(true);
  });

  it("classifies provider rate-limit messages before they can enter an endless retry loop", () => {
    const messages = [
      "Too Many Requests",
      "Rate limit exceeded. Please try again later.",
      "The request rate exceeds the current model Concurrency limit 1200.",
      "Your account has reached the rate limit; please reduce request frequency.",
      "您的账户已达到速率限制，请您控制请求频率",
      "429 Too Many Requests",
    ];

    for (const message of messages) {
      expect(isDeterministicProviderRetryError(message), message).toBe(true);
    }
  });

  it("does not classify ordinary provider failures as deterministic rate limits", () => {
    expect(isDeterministicProviderRetryError("Internal server error")).toBe(false);
    expect(isDeterministicProviderRetryError("Model not found")).toBe(false);
    expect(isDeterministicProviderRetryError("Network timeout")).toBe(false);
  });
});

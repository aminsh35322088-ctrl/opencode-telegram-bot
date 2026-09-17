import { describe, expect, it } from "vitest";
import { isDeterministicProviderRetryError } from "../../src/opencode/provider-error-policy.js";

describe("opencode/provider-error-policy", () => {
  it("never overrides OpenCode retryability for provider errors", () => {
    const messages = [
      "prompt is longer than the free tier allows for a single request",
      "insufficient balance",
      "The request is invalid: Input tokens exceed the configured limit of 192000 tokens.",
      "maximum context length is 128000 tokens",
      "context length exceeded",
      "Too Many Requests",
      "Rate limit exceeded. Please try again later.",
      "The request rate exceeds the current model Concurrency limit 1200.",
      "Your account has reached the rate limit; please reduce request frequency.",
      "您的账户已达到速率限制，请您控制请求频率",
      "429 Too Many Requests",
      "Internal server error",
      "Model not found",
      "Network timeout",
    ];

    for (const message of messages) {
      expect(isDeterministicProviderRetryError(message), message).toBe(false);
    }
  });
});

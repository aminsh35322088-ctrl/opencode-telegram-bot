import { describe, expect, it } from "vitest";
import { formatModelForButton, formatModelForDisplay, formatModelName } from "../../../src/app/types/model.js";

describe("model/types", () => {
  it("formats a provider model as a clean model-only button", () => {
    expect(formatModelForButton("openai", "gpt-5.6-sol")).toBe("🧠 GPT 5.6 Sol");
  });

  it("prefers an advertised provider model name", () => {
    expect(formatModelName("openai/gpt-5.6", "Chat GPT 5.6 Sol")).toBe("Chat GPT 5.6 Sol");
    expect(formatModelForButton("provider", "gpt-5.6", "Chat GPT 5.6 Sol")).toBe("🧠 Chat GPT 5.6 Sol");
  });

  it("formats model display without provider/company name", () => {
    expect(formatModelForDisplay("anthropic", "claude-sonnet-4")).toBe("Claude Sonnet 4");
  });

  it("normalizes common model tokens", () => {
    expect(formatModelName("deepseek/deepseek-r1")).toBe("DeepSeek R 1");
    expect(formatModelName("qwen/qwen3-coder")).toBe("Qwen 3 Coder");
  });

  it("truncates only the displayed model name", () => {
    const result = formatModelForButton("very-long-provider-name", "very-long-model-name-v2-preview");
    expect(result.startsWith("🧠 ")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(48);
    expect(result).not.toContain("very-long-provider-name");
  });
});

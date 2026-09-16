import { describe, expect, it } from "vitest";
import { matchesModelCenterSearch } from "../../../src/bot/menus/model-center-menu.js";

describe("Model Center search matching", () => {
  const model = {
    providerID: "cline",
    modelID: "openai/gpt-5.6-sol",
    name: "GPT-5.6 Sol",
  };

  it("matches human-readable names across punctuation and separators", () => {
    expect(matchesModelCenterSearch(model, "Cline", "gpt 5.6 sol")).toBe(true);
    expect(matchesModelCenterSearch(model, "Cline", "gpt-5-6-sol")).toBe(true);
  });

  it("matches model IDs and provider names", () => {
    expect(matchesModelCenterSearch(model, "Cline", "openai gpt 5.6")).toBe(true);
    expect(matchesModelCenterSearch(model, "Cline", "cline gpt sol")).toBe(true);
  });

  it("requires all query tokens to match", () => {
    expect(matchesModelCenterSearch(model, "Cline", "gpt gemini")).toBe(false);
  });
});

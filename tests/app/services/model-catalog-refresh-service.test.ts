import { describe, expect, it } from "vitest";
import { __catalogsEqualForTests } from "../../../src/app/services/model-catalog-refresh-service.js";

const base = {
  id: "model-a",
  name: "Model A",
  freeStatus: "unknown" as const,
  freeConfidence: "none" as const,
  freeSource: "none" as const,
  freeReason: "missing pricing",
};

describe("model catalog refresh comparison", () => {
  it("detects metadata-only changes for the same model ID", () => {
    expect(__catalogsEqualForTests([base], [{ ...base, freeStatus: "free", freeConfidence: "high", freeSource: "pricing", freeReason: "zero pricing" }])).toBe(false);
  });

  it("detects evidence-source changes for the same classification", () => {
    expect(__catalogsEqualForTests([base], [{ ...base, freeSource: "heuristic" }])).toBe(false);
  });

  it("treats identical model metadata as unchanged", () => {
    expect(__catalogsEqualForTests([base], [{ ...base }])).toBe(true);
  });

  it("detects additions and removals", () => {
    expect(__catalogsEqualForTests([base], [{ ...base }, { ...base, id: "model-b" }])).toBe(false);
    expect(__catalogsEqualForTests([base, { ...base, id: "model-b" }], [base])).toBe(false);
  });
});

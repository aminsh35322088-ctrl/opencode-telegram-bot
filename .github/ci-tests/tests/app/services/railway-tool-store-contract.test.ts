import { describe, expect, it } from "vitest";
import * as railwayService from "../../../src/app/services/railway-integration-service.js";

// The railway custom tool loads this service from /app/dist at runtime via a
// dynamic import, so static import scanning cannot see these references.
const REQUIRED_BY_RAILWAY_TOOL = ["getRailwayToken", "getActiveRailwayTokenType", "getActiveRailwayAccount"] as const;

describe("railway custom tool store contract", () => {
  it("exports every service function the railway tool interface requires", () => {
    for (const name of REQUIRED_BY_RAILWAY_TOOL) {
      expect(typeof (railwayService as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});

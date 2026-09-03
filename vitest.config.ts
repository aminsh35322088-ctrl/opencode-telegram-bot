import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    // Keep the test worker bounded if a test or lifecycle hook leaks an
    // unresolved promise. Do not retry failures automatically: flaky tests
    // must remain visible while we debug lifecycle/race conditions.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    teardownTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    },
  },
});

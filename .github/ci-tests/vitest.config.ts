import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // A CI validation run must never pass just because test discovery broke.
    passWithNoTests: false,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    // Keep the test worker bounded if a test or lifecycle hook leaks an
    // unresolved promise. Do not retry failures automatically: flaky tests
    // must remain visible while we debug lifecycle/race conditions.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    teardownTimeout: 10_000,
    retry: 0,
    // Pin CI to process workers and cap concurrency at two forks. Keeping the
    // pool/isolation choices explicit protects us from future default changes;
    // maxForks bounds worker concurrency, not per-process memory usage.
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 2,
        isolate: true,
      },
    },
    // Do not opt tests within a file into concurrent sequencing. File-level
    // parallelism remains bounded by maxForks above.
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    },
  },
});

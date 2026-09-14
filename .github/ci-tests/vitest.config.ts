import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
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
    retry: 0,
    // Process pool with hard isolation: every test file gets a pristine
    // module graph, so module-level singletons (aggregators, async-local
    // stores) can never leak state across files or depend on execution
    // order. Forks (not threads) keep AsyncLocalStorage semantics reliable.
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        // Bounded parallelism: several test files run at once while peak
        // memory stays inside a fixed envelope, independent of runner cores.
        maxForks: 2,
        isolate: true,
      },
    },
    // Tests inside a file must never interleave; concurrency across files
    // is already provided by the fork pool above.
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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("clean build invalidates TypeScript incremental state before emitting dist", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string,string> };
  const build = pkg.scripts?.build ?? "";
  const cleanPhase = build.split("&& tsc", 1)[0] ?? "";
  assert.match(cleanPhase, /rmSync\(['"]dist['"]/u);
  assert.match(cleanPhase, /node_modules\/\.cache\/tsc\/build\.tsbuildinfo/u);
});

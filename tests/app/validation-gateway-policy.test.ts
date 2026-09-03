import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("validation gateway policy", () => {
  it("blocks direct validation/download paths in OpenCode permissions", async () => {
    const config = JSON.parse(await readFile(path.join(root, "opencode.json"), "utf8")) as {
      permission?: { bash?: Record<string, string> };
    };
    const bash = config.permission?.bash ?? {};
    for (const pattern of [
      "npx *",
      "npm ci *",
      "npm install *",
      "npm exec *",
      "tsc *",
      "vitest *",
      "eslint *",
      "npm run test *",
      "npm run typecheck *",
      "npm run lint *",
      "npm run build *",
    ]) {
      expect(bash[pattern]).toBe("deny");
    }
  });

  it("keeps the validation gateway free of direct installer invocations", async () => {
    const source = await readFile(path.join(root, ".opencode/tools/test-runner.ts"), "utf8");
    expect(source).not.toMatch(/\bspawn\(\s*["']npx["']/);
    expect(source).not.toMatch(/\bspawn\(\s*["'](?:npm|pnpm|yarn|bun)["']/);
    expect(source).not.toContain("execFile(\"npx\"");
    expect(source).not.toContain("execFile(\"npm\"");
    expect(source).toContain("killProcessTree");
    expect(source).toContain("CACHED:");
  });
});

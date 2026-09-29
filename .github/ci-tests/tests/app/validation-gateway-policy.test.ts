import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MANAGED_OPENCODE_PERMISSION_POLICY } from "../../src/opencode/managed-policy.js";
import { describe, expect, it } from "vitest";
import { MANAGED_OPENCODE_PERMISSION_POLICY } from "../../src/opencode/managed-policy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("validation gateway policy", () => {
  it("blocks direct validation/download paths even when wrapped", async () => {
    const bash = MANAGED_OPENCODE_PERMISSION_POLICY.bash;
    for (const pattern of [
      "*npx*",
      "*npm ci*",
      "*npm install*",
      "*npm exec*",
      "*npm test*",
      "*npm run*test*",
      "*npm run*typecheck*",
      "*npm run*lint*",
      "*npm run*build*",
      "*pnpm install*",
      "*pnpm dlx*",
      "*pnpm test*",
      "*yarn install*",
      "*yarn dlx*",
      "*yarn test*",
      "*bun install*",
      "*bunx*",
      "*bun test*",
    ]) {
      expect(bash[pattern]).toBe("deny");
    }
  });

  it("permits the baked validation toolchain binaries", async () => {
    const bash = MANAGED_OPENCODE_PERMISSION_POLICY.bash;
    for (const pattern of [
      "*tsc *",
      "*vitest *",
      "*eslint *",
      "*node_modules/.bin/tsc*",
      "*node_modules/.bin/vitest*",
      "*node_modules/.bin/eslint*",
    ]) {
      expect(bash[pattern]).toBe("allow");
    }
  });

  it("keeps the validation gateway free of direct installer invocations", async () => {
    const filePath = path.join(root, ".opencode/tools/test-runner.ts");
    try {
      const source = await readFile(filePath, "utf8");
      expect(source).not.toMatch(/\bspawn\(\s*["']npx["']/);
      expect(source).not.toMatch(/\bspawn\(\s*["'](?:npm|pnpm|yarn|bun)["']/);
      expect(source).not.toContain("execFile(\"npx\"");
      expect(source).not.toContain("execFile(\"npm\"");
      expect(source).toContain("killProcessTree");
      expect(source).toContain("CACHED:");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  });
});

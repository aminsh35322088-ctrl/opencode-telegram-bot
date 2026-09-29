import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve("src");
const REGISTRY = path.resolve("src/runtime/process-budget.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("process budget policy", () => {
  it("forbids raw child-process execution outside the central registry", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      if (path.resolve(file) === REGISTRY) continue;
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const rawChildImport =
          /from\s+["'](?:node:)?child_process["']/u.test(line) &&
          !/^\s*import\s+type\b/u.test(line);
        const rawRequire = /(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)/u.test(line);
        const bunSpawn = /\bBun\.spawn\s*\(/u.test(line);
        if (rawChildImport || rawRequire || bunSpawn) {
          offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

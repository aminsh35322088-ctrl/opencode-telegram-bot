import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 30000;

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type PackageJson = { scripts?: Record<string, string> };

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true).catch(() => false);
}

async function detectPackageManager(worktree: string): Promise<PackageManager> {
  if (await exists(path.join(worktree, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(worktree, "yarn.lock"))) return "yarn";
  if (await exists(path.join(worktree, "bun.lockb")) || await exists(path.join(worktree, "bun.lock"))) return "bun";
  return "npm";
}

function parseArgs(input?: string): string[] {
  const value = input?.trim();
  if (!value) return [];
  const output: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (const char of value) {
    if (escaping) { current += char; escaping = false; continue; }
    if (char === "\\") { escaping = true; continue; }
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/u.test(char)) { if (current) { output.push(current); current = ""; } continue; }
    current += char;
  }
  if (quote) throw new Error("Unclosed quote in args.");
  if (escaping) current += "\\";
  if (current) output.push(current);
  return output;
}

async function packageJson(worktree: string): Promise<PackageJson> {
  try {
    return JSON.parse(await fs.readFile(path.join(worktree, "package.json"), "utf8")) as PackageJson;
  } catch {
    throw new Error("package.json was not found or is invalid.");
  }
}

function scriptInvocation(pm: PackageManager, script: string, extra: string[]): { cmd: string; args: string[] } {
  if (pm === "npm") return { cmd: "npm", args: ["run", script, ...(extra.length ? ["--", ...extra] : [])] };
  if (pm === "pnpm") return { cmd: "pnpm", args: ["run", script, ...(extra.length ? ["--", ...extra] : [])] };
  if (pm === "yarn") return { cmd: "yarn", args: ["run", script, ...extra] };
  return { cmd: "bun", args: ["run", script, ...(extra.length ? ["--", ...extra] : [])] };
}

async function run(cmd: string, args: string[], worktree: string, timeout = 180000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: worktree,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: "true" },
    });
    return (stdout.trim() || stderr.trim() || "OK").slice(0, MAX_OUTPUT_CHARS);
  } catch (error) {
    const e = error as { code?: string | number; stdout?: string; stderr?: string; message?: string };
    if (e.code === "ENOENT") throw new Error(`${cmd} is not installed in this runtime.`);
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    throw new Error((output || e.message || `${cmd} failed`).slice(0, MAX_OUTPUT_CHARS));
  }
}

async function runLocalBinary(worktree: string, binary: string, args: string[], timeout = 180000): Promise<string> {
  const executable = path.join(worktree, "node_modules", ".bin", process.platform === "win32" ? `${binary}.cmd` : binary);
  if (!await exists(executable)) {
    throw new Error(`No package script and no local ${binary} binary are available. Install project dev dependencies explicitly; this tool will not download packages via npx.`);
  }
  return run(executable, args, worktree, timeout);
}

export default tool({
  description: "Run project tests, lint, typecheck, build, a specific test file, or lint-fix. Uses package scripts/local binaries only and never downloads tooling implicitly.",
  args: {
    action: tool.schema.enum(["test", "lint", "typecheck", "build", "test-file", "lint-fix"]).describe("Validation action to execute."),
    args: tool.schema.string().optional().describe("Additional arguments; quotes/backslash escapes are supported."),
  },
  async execute(args, context) {
    const worktree = context.worktree;
    const pkg = await packageJson(worktree);
    const pm = await detectPackageManager(worktree);
    const extra = parseArgs(args.args);

    if (args.action === "test-file") {
      if (!extra.length) throw new Error('test-file requires a test file path in args.');
      if (pkg.scripts?.test) {
        const invocation = scriptInvocation(pm, "test", extra);
        return run(invocation.cmd, invocation.args, worktree);
      }
      const config = path.join(worktree, ".github", "ci-tests", "vitest.config.ts");
      const vitestArgs = ["run", ...(await exists(config) ? ["--config", config] : []), ...extra];
      return runLocalBinary(worktree, "vitest", vitestArgs);
    }

    if (args.action === "test") {
      if (pkg.scripts?.test) {
        const invocation = scriptInvocation(pm, "test", extra);
        return run(invocation.cmd, invocation.args, worktree);
      }
      const config = path.join(worktree, ".github", "ci-tests", "vitest.config.ts");
      if (!await exists(path.join(worktree, "tests"))) {
        throw new Error("This repository has no test script and CI-only tests are not materialized in this runtime.");
      }
      return runLocalBinary(worktree, "vitest", ["run", ...(await exists(config) ? ["--config", config] : []), ...extra]);
    }

    if (args.action === "lint-fix") {
      if (pkg.scripts?.lint) {
        const invocation = scriptInvocation(pm, "lint", ["--fix", ...extra]);
        return run(invocation.cmd, invocation.args, worktree);
      }
      return runLocalBinary(worktree, "eslint", [".", "--fix", ...extra]);
    }

    const script = args.action === "typecheck" ? "typecheck" : args.action;
    if (pkg.scripts?.[script]) {
      const invocation = scriptInvocation(pm, script, extra);
      return run(invocation.cmd, invocation.args, worktree);
    }

    if (args.action === "lint") return runLocalBinary(worktree, "eslint", [".", ...extra]);
    if (args.action === "typecheck") return runLocalBinary(worktree, "tsc", ["--noEmit", ...extra]);
    if (args.action === "build") throw new Error("No build script is defined in package.json.");

    throw new Error(`Unknown test action: ${args.action}`);
  },
});

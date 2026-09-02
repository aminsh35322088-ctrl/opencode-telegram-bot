import { accessSync } from "node:fs";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

type Mode = "test" | "build" | "lint" | "typecheck";

function managerFor(worktree: string, packageJson: Record<string, unknown>): { bin: string; prefix: string[] } {
  if (packageJson.packageManager && typeof packageJson.packageManager === "string") {
    const name = packageJson.packageManager.split("@")[0];
    if (name === "pnpm") return { bin: "pnpm", prefix: ["run"] };
    if (name === "yarn") return { bin: "yarn", prefix: [] };
    if (name === "bun") return { bin: "bun", prefix: ["run"] };
  }
  if (fsSyncExists(path.join(worktree, "pnpm-lock.yaml"))) return { bin: "pnpm", prefix: ["run"] };
  if (fsSyncExists(path.join(worktree, "yarn.lock"))) return { bin: "yarn", prefix: [] };
  if (fsSyncExists(path.join(worktree, "bun.lockb")) || fsSyncExists(path.join(worktree, "bun.lock"))) return { bin: "bun", prefix: ["run"] };
  return { bin: "npm", prefix: ["run"] };
}

function fsSyncExists(file: string): boolean {
  try {
    accessSync(file);
    return true;
  } catch {
    return false;
  }
}

async function findPackageJson(root: string, maxDepth = 3): Promise<string | null> {
  const direct = path.join(root, "package.json");
  if (fsSyncExists(direct)) return direct;
  if (maxDepth <= 0) return null;

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
    const found = await findPackageJson(path.join(root, entry.name), maxDepth - 1);
    if (found) return found;
  }

  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

export default tool({
  description: "Run the project's test, build, lint, or typecheck script. Automatically finds package.json in the worktree (including project subdirectories).",
  args: {
    mode: tool.schema.enum(["test", "build", "lint", "typecheck"]).describe("Validation task to run."),
    filter: tool.schema.string().optional().describe("Optional test file, test name, or script argument."),
  },
  async execute(args, context) {
    const packageJsonPath = await findPackageJson(context.worktree);
    if (!packageJsonPath) {
      return `NOT TESTABLE: No package.json found in worktree '${context.worktree}' (searched up to 3 directory levels).`;
    }

    const projectRoot = path.dirname(packageJsonPath);
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; packageManager?: string };
    const script = pkg.scripts?.[args.mode];
    if (!script) return `NOT TESTABLE: No '${args.mode}' script is defined in ${packageJsonPath}.`;

    const manager = managerFor(projectRoot, pkg);
    const command = [...manager.prefix, args.mode];
    if (args.filter) command.push("--", args.filter);

    try {
      const { stdout, stderr } = await execFileAsync(manager.bin, command, {
        cwd: projectRoot,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CI: process.env.CI || "1" },
        signal: context.abort,
      });
      return `PASS: ${manager.bin} ${command.join(" ")} (project: ${projectRoot})\n${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.slice(-12000);
    } catch (error) {
      const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      const status = isAbortError(error) || context.abort.aborted ? "ABORTED" : `FAIL (${e.code ?? "unknown"})`;
      return `${status}: ${manager.bin} ${command.join(" ")} (project: ${projectRoot})\n${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.slice(-12000);
    }
  },
});

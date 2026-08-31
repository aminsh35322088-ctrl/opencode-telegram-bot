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

export default tool({
  description: "Run the project's test, build, lint, or typecheck script with a concise structured result. Use after code changes to verify the work.",
  args: {
    mode: tool.schema.enum(["test", "build", "lint", "typecheck"]).describe("Validation task to run."),
    filter: tool.schema.string().optional().describe("Optional test file, test name, or script argument."),
  },
  async execute(args, context) {
    const raw = await fs.readFile(path.join(context.worktree, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; packageManager?: string };
    const script = pkg.scripts?.[args.mode];
    if (!script) return `No '${args.mode}' script is defined in package.json.`;

    const manager = managerFor(context.worktree, pkg);
    const command = [...manager.prefix, args.mode];
    if (args.filter) command.push("--", args.filter);

    try {
      const { stdout, stderr } = await execFileAsync(manager.bin, command, {
        cwd: context.worktree,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 15 * 60 * 1000,
        env: { ...process.env, CI: process.env.CI || "1" },
      });
      return `PASS: ${manager.bin} ${command.join(" ")}\n${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.slice(-12000);
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      return `FAIL (${e.code ?? "unknown"}): ${manager.bin} ${command.join(" ")}\n${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.slice(-12000);
    }
  },
});

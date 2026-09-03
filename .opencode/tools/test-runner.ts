import { accessSync } from "node:fs";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

type Mode = "test" | "build" | "lint" | "typecheck";

type PackageJson = {
  scripts?: Record<string, string>;
  packageManager?: string;
};

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

function validationTimeoutMs(): number {
  const configured = Number.parseInt(process.env.OPENCODE_TEST_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(configured, MAX_TIMEOUT_MS);
}

function buildValidationEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, CI: process.env.CI || "1" };
  const extraBin = ["/usr/local/bin", "/usr/bin"];
  const existingPath = env.PATH?.split(path.delimiter) ?? [];
  env.PATH = [...extraBin, ...existingPath.filter((entry) => !extraBin.includes(entry))].join(path.delimiter);
  env.NPM_CONFIG_CACHE = env.NPM_CONFIG_CACHE || "/data/.cache/npm";
  return env;
}

export default tool({
  description: "Run the project's test, build, lint, or typecheck script without installing dependencies. Reuses the existing dependency tree, prefers the container's preinstalled toolchain when a local binary is absent, and aborts stalled validation after a bounded timeout.",
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
    const pkg = JSON.parse(raw) as PackageJson;
    const script = pkg.scripts?.[args.mode];
    if (!script) return `NOT TESTABLE: No '${args.mode}' script is defined in ${packageJsonPath}.`;

    const manager = managerFor(projectRoot, pkg);
    const command = [...manager.prefix, args.mode];
    if (args.filter) command.push("--", args.filter);

    const timeoutMs = validationTimeoutMs();
    const startedAt = Date.now();

    try {
      const { stdout, stderr } = await execFileAsync(manager.bin, command, {
        cwd: projectRoot,
        maxBuffer: 4 * 1024 * 1024,
        env: buildValidationEnv(),
        signal: context.abort,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
      });
      return `PASS: ${manager.bin} ${command.join(" ")} (project: ${projectRoot}, elapsedMs=${Date.now() - startedAt})\n${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.slice(-12000);
    } catch (error) {
      const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      const elapsedMs = Date.now() - startedAt;
      const timedOut = e.code === "ETIMEDOUT";
      const status = isAbortError(error) || context.abort.aborted
        ? "ABORTED"
        : timedOut
          ? `TIMEOUT after ${elapsedMs}ms`
          : `FAIL (${e.code ?? "unknown"})`;
      return `${status}: ${manager.bin} ${command.join(" ")} (project: ${projectRoot})\nNo dependency installation was attempted.\n${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.slice(-12000);
    }
  },
});

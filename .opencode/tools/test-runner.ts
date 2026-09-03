import { accessSync, promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const GIT_PROBE_TIMEOUT_MS = 5 * 1000;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_ROOT = process.env.OPENCODE_TEST_CACHE_DIR || "/data/.cache/opencode/test-runner-v2";
const GATEWAY_VERSION = "2";

type Mode = "test" | "build" | "lint" | "typecheck";

type PackageJson = {
  scripts?: Record<string, string>;
  packageManager?: string;
};

type GitState = {
  head: string;
  clean: boolean;
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
  const env = { ...process.env, CI: process.env.CI || "1", NO_COLOR: process.env.NO_COLOR || "1" };
  const extraBin = ["/usr/local/bin", "/usr/bin"];
  const existingPath = env.PATH?.split(path.delimiter) ?? [];
  env.PATH = [...extraBin, ...existingPath.filter((entry) => !extraBin.includes(entry))].join(path.delimiter);
  env.NPM_CONFIG_CACHE = env.NPM_CONFIG_CACHE || "/data/.cache/npm";
  return env;
}

async function getGitState(projectRoot: string): Promise<GitState | null> {
  try {
    const [headResult, statusResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, timeout: GIT_PROBE_TIMEOUT_MS }),
      execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: projectRoot, timeout: GIT_PROBE_TIMEOUT_MS }),
    ]);
    const head = headResult.stdout.trim();
    if (!head) return null;
    return { head, clean: statusResult.stdout.trim().length === 0 };
  } catch {
    return null;
  }
}

function cacheKey(projectRoot: string, mode: Mode, filter: string | undefined, gitState: GitState | null): string | null {
  if (!gitState?.clean) return null;
  const fingerprint = [GATEWAY_VERSION, projectRoot, gitState.head, mode, filter ?? ""].join("\u0000");
  return crypto.createHash("sha256").update(fingerprint).digest("hex");
}

async function readCachedResult(key: string): Promise<string | null> {
  try {
    const file = path.join(CACHE_ROOT, `${key}.json`);
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { status?: string; output?: string };
    if (parsed.status !== "PASS" || typeof parsed.output !== "string") return null;
    return `CACHED: ${parsed.output}`;
  } catch {
    return null;
  }
}

async function writeCachedResult(key: string, output: string): Promise<void> {
  try {
    await fs.mkdir(CACHE_ROOT, { recursive: true });
    const file = path.join(CACHE_ROOT, `${key}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ status: "PASS", output }), "utf8");
    await fs.rename(temp, file);
  } catch {
    // Cache is an optimization; validation success must never depend on it.
  }
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
      return;
    }
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
}

function runBounded(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }) {
  return new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean; error?: Error }>((resolve) => {
    if (options.signal.aborted) {
      resolve({ stdout: "", stderr: "", code: null, signal: null, timedOut: false, aborted: true });
      return;
    }

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString();
      return next.length > MAX_OUTPUT_CHARS ? `${next.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]` : next;
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal.removeEventListener("abort", onAbort);
    };

    const finish = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, timedOut, aborted, ...result });
    };

    const stop = () => {
      killProcessTree(child);
      forceKillTimer = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch { /* already exited */ }
      }, 2000);
      forceKillTimer.unref?.();
    };

    const onAbort = () => {
      aborted = true;
      stop();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timer.unref?.();
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

export default tool({
  description: "Validation gateway: run the project's test, build, lint, or typecheck script without dependency installation, with bounded process-tree cleanup and safe short-lived caching. Never use npx/npm ci from this path.",
  args: {
    mode: tool.schema.enum(["test", "build", "lint", "typecheck"]).describe("Validation task to run."),
    filter: tool.schema.string().optional().describe("Optional test file, test name, or script argument."),
    cache: tool.schema.boolean().optional().describe("Reuse a recent successful result when the worktree is clean and unchanged."),
  },
  async execute(args, context) {
    const packageJsonPath = await findPackageJson(context.worktree);
    if (!packageJsonPath) return `NOT TESTABLE: No package.json found in worktree '${context.worktree}' (searched up to 3 directory levels).`;

    const projectRoot = path.dirname(packageJsonPath);
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as PackageJson;
    const script = pkg.scripts?.[args.mode];
    if (!script) return `NOT TESTABLE: No '${args.mode}' script is defined in ${packageJsonPath}.`;

    const gitState = await getGitState(projectRoot);
    const key = args.cache === false ? null : cacheKey(projectRoot, args.mode, args.filter, gitState);
    if (key) {
      const cached = await readCachedResult(key);
      if (cached) return cached;
    }

    const manager = managerFor(projectRoot, pkg);
    const command = [...manager.prefix, args.mode];
    if (args.filter) command.push("--", args.filter);

    const timeoutMs = validationTimeoutMs();
    const startedAt = Date.now();
    const result = await runBounded(manager.bin, command, {
      cwd: projectRoot,
      env: buildValidationEnv(),
      timeoutMs,
      signal: context.abort,
    });
    const elapsedMs = Date.now() - startedAt;
    const displayCommand = `${manager.bin} ${command.join(" ")}`;
    const output = `${result.stdout.trim()}${result.stderr.trim() ? `\n${result.stderr.trim()}` : ""}`.trim().slice(-12000);

    if (result.aborted || isAbortError(result.error) || context.abort.aborted) {
      return `ABORTED: ${displayCommand} (project: ${projectRoot}, elapsedMs=${elapsedMs})\nNo dependency installation was attempted.\n${output}`;
    }
    if (result.timedOut) {
      return `TIMEOUT after ${elapsedMs}ms: ${displayCommand} (project: ${projectRoot})\nThe process tree was terminated; no dependency installation was attempted.\n${output}`;
    }
    if (result.error) {
      return `FAIL (spawn-error): ${displayCommand} (project: ${projectRoot})\n${result.error.message}\n${output}`;
    }
    if (result.code !== 0) {
      return `FAIL (exit=${result.code ?? "unknown"}): ${displayCommand} (project: ${projectRoot}, elapsedMs=${elapsedMs})\n${output}`;
    }

    const success = `PASS: ${displayCommand} (project: ${projectRoot}, elapsedMs=${elapsedMs})\n${output}`.trim().slice(-12000);
    if (key) await writeCachedResult(key, success);
    return success;
  },
});

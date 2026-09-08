import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { tool } from "@opencode-ai/plugin";

const workspace = "/data/workspace";
const testRoot = path.join(os.tmpdir(), "opencode-full-test-suite");
const bakedDeps = process.env.OPENCODE_TEST_DEPS ?? "/opt/test-deps/node_modules";
const bakedBin = path.join(bakedDeps, ".bin");
const volumeBudgetBytes = Number(process.env.OPENCODE_DATA_VOLUME_BUDGET_MB ?? 500) * 1024 * 1024;
const criticalFreeBytes = Number(process.env.OPENCODE_DATA_VOLUME_CRITICAL_MB ?? 100) * 1024 * 1024;
const warningFreeBytes = Number(process.env.OPENCODE_DATA_VOLUME_WARN_MB ?? 150) * 1024 * 1024;
const defaultCommandTimeoutMs = Number(process.env.OPENCODE_TEST_COMMAND_TIMEOUT_MS ?? 300_000);
const killGraceMs = Number(process.env.OPENCODE_TEST_KILL_GRACE_MS ?? 2_000);
const maxOutputBytes = 4 * 1024 * 1024;

type CommandResult = {
  command: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
};

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > maxOutputBytes ? next.slice(-maxOutputBytes) : next;
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    // On Linux the detached child is a process-group leader, so a negative PID
    // targets the whole validation command tree rather than just the wrapper.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited; nothing left to clean up.
    }
  }
}

async function run(bin: string, args: string[], cwd = workspace, timeout = defaultCommandTimeoutMs): Promise<CommandResult> {
  const started = Date.now();
  const command = [bin, ...args].join(" ");
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  return await new Promise<CommandResult>((resolve) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let forceKillHandle: NodeJS.Timeout | undefined;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      resolve({ command, exitCode, durationMs: Date.now() - started, ...(timedOut ? { timedOut: true } : {}), stdout: stdout.trim(), stderr: stderr.trim() });
    };

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "1", NODE_ENV: "test" },
      });
    } catch (error) {
      finish(1);
      stderr = String(error);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (!stderr) stderr = String(error);
      finish(1);
    });
    child.on("close", (code, signal) => {
      if (timedOut && !stderr.includes("timed out")) stderr = `${stderr}\nCommand timed out after ${timeout}ms and the entire process tree was terminated.`.trim();
      finish(code ?? (signal ? 1 : 0));
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      stderr = `${stderr}\nCommand timed out after ${timeout}ms; terminating process tree.`.trim();
      killProcessTree(child.pid, "SIGTERM");
      forceKillHandle = setTimeout(() => killProcessTree(child.pid, "SIGKILL"), killGraceMs);
    }, timeout);
  });
}

async function dataFreeBytes(): Promise<number> {
  const stats = await fs.statfs("/data");
  return stats.bavail * stats.bsize;
}

function diskState(freeBytes: number) {
  return {
    budgetBytes: volumeBudgetBytes,
    budgetMb: Math.round(volumeBudgetBytes / 1024 / 1024),
    freeBytes,
    freeMb: Math.floor(freeBytes / 1024 / 1024),
    status: freeBytes < criticalFreeBytes ? "critical" : freeBytes < warningFreeBytes ? "warning" : "healthy",
  };
}

async function prepareSandbox(): Promise<void> {
  await fs.rm(testRoot, { recursive: true, force: true });
  await fs.mkdir(testRoot, { recursive: true });
  await fs.cp(path.join(workspace, ".github/ci-tests/tests"), path.join(testRoot, "tests"), { recursive: true });
  const baseTsconfig = JSON.parse(await fs.readFile(path.join(workspace, "tsconfig.json"), "utf8")) as Record<string, unknown>;
  const baseCompilerOptions = (baseTsconfig.compilerOptions ?? {}) as Record<string, unknown>;
  await fs.writeFile(path.join(testRoot, "tsconfig.json"), JSON.stringify({ ...baseTsconfig, compilerOptions: { ...baseCompilerOptions, outDir: path.join(testRoot, "dist"), rootDir: ".", tsBuildInfoFile: path.join(testRoot, "build.tsbuildinfo") }, include: ["src/**/*"], exclude: ["node_modules", "**/*.test.ts"] }));
  await fs.writeFile(path.join(testRoot, "tsconfig.test.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { rootDir: ".", noEmit: true, tsBuildInfoFile: path.join(testRoot, "test.tsbuildinfo") }, include: ["src/**/*", "tests/**/*"], exclude: ["node_modules", "dist"] }));
  await fs.symlink(path.join(workspace, "src"), path.join(testRoot, "src"));
  await fs.symlink(bakedDeps, path.join(testRoot, "node_modules"));
  await fs.writeFile(path.join(testRoot, "vitest.config.ts"), `import { defineConfig } from "vitest/config";\n\nexport default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.ts"], setupFiles: ["./tests/setup.ts"], passWithNoTests: false, clearMocks: true, restoreMocks: true, mockReset: true, testTimeout: 20_000, hookTimeout: 20_000, teardownTimeout: 10_000, coverage: { provider: "v8", enabled: false } } });\n`);
}

async function checkDisk(): Promise<CommandResult | null> {
  const free = await dataFreeBytes();
  if (free < criticalFreeBytes) return { command: "disk-budget", exitCode: 2, durationMs: 0, stdout: "", stderr: JSON.stringify(diskState(free)) };
  return null;
}

export default tool({
  description: "Run the repository's complete CI-equivalent validation suite from the baked image toolchain without installing packages or writing test/build output to the 500MB /data volume. Every external command has a hard timeout and its entire process tree is terminated on timeout.",
  args: {},
  async execute() {
    const before = await dataFreeBytes();
    if (before < criticalFreeBytes) return JSON.stringify({ ok: false, blocked: true, reason: "Insufficient free space on /data", disk: diskState(before) }, null, 2);
    const workspaceDeps = path.join(workspace, "node_modules");
    const depsLink = await fs.readlink(workspaceDeps).catch(() => null);
    if (depsLink === null) return JSON.stringify({ ok: false, blocked: true, reason: `${workspaceDeps} must be a symlink to the baked dependency tree`, expected: bakedDeps }, null, 2);
    const depsResolved = await fs.realpath(workspaceDeps).catch(() => "");
    const bakedResolved = await fs.realpath(bakedDeps).catch(() => "");
    if (!bakedResolved || depsResolved !== bakedResolved) return JSON.stringify({ ok: false, blocked: true, reason: "Workspace dependencies are not linked to the baked tree", expected: bakedDeps, actual: depsResolved || depsLink }, null, 2);
    if (!(await fs.stat(bakedBin).catch(() => null))?.isDirectory()) return JSON.stringify({ ok: false, blocked: true, reason: `Baked dependency binaries are missing: ${bakedBin}` }, null, 2);
    for (const binary of ["tsc", "eslint", "vitest"]) if (!(await fs.stat(path.join(bakedBin, binary)).catch(() => null))) return JSON.stringify({ ok: false, blocked: true, reason: `Baked validation binary is missing: ${path.join(bakedBin, binary)}` }, null, 2);

    const results: CommandResult[] = [];
    try {
      await prepareSandbox();
      const suiteDisk = await dataFreeBytes();
      if (suiteDisk < criticalFreeBytes) return JSON.stringify({ ok: false, blocked: true, reason: "Insufficient /data capacity before validation", disk: diskState(suiteDisk) }, null, 2);

      if (process.env.GITHUB_EVENT_PATH && await fs.stat(process.env.GITHUB_EVENT_PATH).catch(() => null)) {
        results.push(await run("node", ["scripts/check-changelog.mjs"]));
      } else {
        results.push({ command: "check:changelog", exitCode: 0, durationMs: 0, stdout: "Skipped: GITHUB_EVENT_PATH is not available outside GitHub Actions.", stderr: "" });
      }
      results.push(await run(path.join(bakedBin, "eslint"), ["src", "--max-warnings=0"], workspace));
      results.push(await run(path.join(bakedBin, "eslint"), [path.join(testRoot, "tests"), "--max-warnings=0"], workspace));
      results.push(await run(path.join(bakedBin, "tsc"), ["--noEmit", "--tsBuildInfoFile", path.join(testRoot, "source.tsbuildinfo")], workspace));
      results.push(await run(path.join(bakedBin, "tsc"), ["-p", path.join(testRoot, "tsconfig.test.json"), "--noEmit"], workspace));
      results.push(await run(path.join(bakedBin, "tsc"), ["--outDir", path.join(testRoot, "dist"), "--tsBuildInfoFile", path.join(testRoot, "build.tsbuildinfo")], workspace));

      const diskCheck = await checkDisk();
      if (diskCheck) {
        results.push(diskCheck);
        return JSON.stringify({ ok: false, blocked: true, reason: "Validation stopped before test runner because /data crossed the critical threshold", disk: diskState(await dataFreeBytes()), results }, null, 2);
      }
      results.push(await run(path.join(bakedBin, "vitest"), ["run", "--config", path.join(testRoot, "vitest.config.ts")], testRoot, Math.max(defaultCommandTimeoutMs, 300_000)));
      const failed = results.filter((result) => result.exitCode !== 0);
      const after = await dataFreeBytes();
      return JSON.stringify({ ok: failed.length === 0, diskBefore: diskState(before), diskAfter: diskState(after), diskDeltaMb: Math.floor((before - after) / 1024 / 1024), warningCrossed: before >= warningFreeBytes && after < warningFreeBytes, sandbox: testRoot, commandTimeoutMs: defaultCommandTimeoutMs, results: results.map(({ stderr, ...result }) => ({ ...result, stderr: stderr.slice(-4000) })) }, null, 2);
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  },
});

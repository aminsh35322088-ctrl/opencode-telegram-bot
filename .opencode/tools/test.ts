import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

async function detectPackageManager(worktree: string): Promise<{ cmd: string; args: string[] }> {
  const packageJsonPath = path.join(worktree, "package.json");
  const yarnLockPath = path.join(worktree, "yarn.lock");
  const pnpmLockPath = path.join(worktree, "pnpm-lock.yaml");
  const bunLockPath = path.join(worktree, "bun.lockb");

  try {
    await fs.access(packageJsonPath);
    if (await fs.access(yarnLockPath).then(() => true).catch(() => false)) {
      return { cmd: "yarn", args: [] };
    }
    if (await fs.access(pnpmLockPath).then(() => true).catch(() => false)) {
      return { cmd: "pnpm", args: [] };
    }
    if (await fs.access(bunLockPath).then(() => true).catch(() => false)) {
      return { cmd: "bun", args: ["run"] };
    }
    return { cmd: "npm", args: ["run"] };
  } catch {
    return { cmd: "npx", args: [] };
  }
}

async function runCommand(cmd: string, args: string[], worktree: string, timeout = 120000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: worktree,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: "true" },
    });
    return stdout.trim() || stderr.trim();
  } catch (error) {
    const e = error as { stderr?: string; message?: string; code?: string | number; stdout?: string };
    if (e.code === "ENOENT") throw new Error(`${cmd} is not installed. Install it first.`);
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    throw new Error(output || e.message || `Command failed: ${cmd} ${args.join(" ")}`);
  }
}

export default tool({
  description: "Run tests, linter, type checker, and build commands. Auto-detects package manager (npm/yarn/pnpm/bun).",
  args: {
    action: tool.schema.enum(["test", "lint", "typecheck", "build", "test-file", "lint-fix"]).describe("Test/CI action to execute."),
    args: tool.schema.string().optional().describe("Additional arguments (e.g., file path for test-file, specific test name)."),
  },
  async execute(args, context) {
    const { action, args: extraArgs } = args;
    const worktree = context.worktree;
    const extra = extraArgs ? extraArgs.split(/\s+/) : [];
    const pm = await detectPackageManager(worktree);

    const hasScript = async (name: string): Promise<boolean> => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(worktree, "package.json"), "utf-8"));
        return !!pkg.scripts?.[name];
      } catch {
        return false;
      }
    };

    switch (action) {
      case "test": {
        if (await hasScript("test")) {
          return runCommand(pm.cmd, [...pm.args, "test", ...extra], worktree);
        }
        return runCommand("npx", ["jest", ...extra], worktree);
      }
      case "test-file": {
        if (!extra.length) throw new Error("File path required. Provide: args=\"path/to/file.test.ts\"");
        if (await hasScript("test")) {
          return runCommand(pm.cmd, [...pm.args, "test", "--", ...extra], worktree);
        }
        return runCommand("npx", ["jest", ...extra], worktree);
      }
      case "lint": {
        if (await hasScript("lint")) {
          return runCommand(pm.cmd, [...pm.args, "lint", ...extra], worktree);
        }
        return runCommand("npx", ["eslint", ".", ...extra], worktree);
      }
      case "lint-fix": {
        if (await hasScript("lint")) {
          return runCommand(pm.cmd, [...pm.args, "lint", "--fix", ...extra], worktree);
        }
        return runCommand("npx", ["eslint", ".", "--fix", ...extra], worktree);
      }
      case "typecheck": {
        if (await hasScript("typecheck")) {
          return runCommand(pm.cmd, [...pm.args, "typecheck", ...extra], worktree);
        }
        if (await hasScript("tsc")) {
          return runCommand(pm.cmd, [...pm.args, "tsc", ...extra], worktree);
        }
        return runCommand("npx", ["tsc", "--noEmit", ...extra], worktree);
      }
      case "build": {
        if (await hasScript("build")) {
          return runCommand(pm.cmd, [...pm.args, "build", ...extra], worktree);
        }
        throw new Error("No 'build' script found in package.json");
      }
      default:
        throw new Error(`Unknown test action: ${action}`);
    }
  },
});

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

function manager(worktree: string): string {
  if (existsSync(path.join(worktree, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(worktree, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(worktree, "bun.lockb")) || existsSync(path.join(worktree, "bun.lock"))) return "bun";
  return "npm";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

function buildEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, CI: process.env.CI || "1" };
  env.NPM_CONFIG_CACHE = env.NPM_CONFIG_CACHE || "/data/.cache/npm";
  return env;
}

export default tool({
  description: "Manage project dependencies using the repository's detected package manager. Interactive install reuses the existing dependency tree and npm cache; it never performs a clean npm ci. Use clean installs only in CI/container provisioning.",
  args: {
    action: tool.schema.enum(["install", "add", "remove", "update", "outdated", "list"]).describe("Dependency operation."),
    packages: tool.schema.string().optional().describe("Space-separated package names. Used by add/remove/update."),
    dev: tool.schema.boolean().optional().describe("For add: install packages as development dependencies."),
  },
  async execute(args, context) {
    const bin = manager(context.worktree);
    const command: string[] = [];
    if (bin === "npm") {
      if (args.action === "install") command.push("install", "--prefer-offline", "--no-audit", "--no-fund");
      else if (args.action === "add") command.push("install", ...(args.dev ? ["-D"] : []), ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "remove") command.push("uninstall", ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "update") command.push("update", "--prefer-offline", "--no-audit", "--no-fund", ...(args.packages?.split(/\s+/) ?? []));
      else command.push(args.action);
    } else if (bin === "pnpm") {
      if (args.action === "install") command.push("install", "--prefer-offline");
      else if (args.action === "add") command.push("add", ...(args.dev ? ["-D"] : []), ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "remove") command.push("remove", ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "update") command.push("update", ...(args.packages?.split(/\s+/) ?? []));
      else command.push(args.action);
    } else if (bin === "yarn") {
      if (args.action === "install") command.push("install", "--prefer-offline");
      else if (args.action === "add") command.push("add", ...(args.dev ? ["-D"] : []), ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "remove") command.push("remove", ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "update") command.push("up", ...(args.packages?.split(/\s+/) ?? []));
      else command.push(args.action);
    } else {
      if (args.action === "install") command.push("install", "--prefer-offline");
      else if (args.action === "add") command.push("add", ...(args.dev ? ["-d"] : []), ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "remove") command.push("remove", ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "update") command.push("update", ...(args.packages?.split(/\s+/) ?? []));
      else command.push(args.action);
    }

    if (["add", "remove", "update"].includes(args.action) && !args.packages) throw new Error(`${args.action} requires packages`);

    try {
      const { stdout, stderr } = await execFileAsync(bin, command, {
        cwd: context.worktree,
        maxBuffer: 4 * 1024 * 1024,
        env: buildEnvironment(),
        signal: context.abort,
      });
      return `${bin} ${command.join(" ")}\n${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.slice(-12000);
    } catch (error) {
      const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      const status = isAbortError(error) || context.abort.aborted ? "ABORTED" : `FAIL (${e.code ?? "unknown"})`;
      return `${status}: ${bin} ${command.join(" ")}\n${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.slice(-12000);
    }
  },
});

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

function manager(worktree: string): string {
  if (fs.existsSync?.(path.join(worktree, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync?.(path.join(worktree, "yarn.lock"))) return "yarn";
  if (fs.existsSync?.(path.join(worktree, "bun.lockb")) || fs.existsSync?.(path.join(worktree, "bun.lock"))) return "bun";
  return "npm";
}

export default tool({
  description: "Manage project dependencies using the repository's detected package manager. Mutating actions require approval.",
  args: {
    action: tool.schema.enum(["install", "add", "remove", "update", "outdated", "list"]).describe("Dependency operation."),
    packages: tool.schema.string().optional().describe("Space-separated package names. Used by add/remove/update."),
    dev: tool.schema.boolean().optional().describe("For add: install packages as development dependencies."),
  },
  async execute(args, context) {
    const bin = manager(context.worktree);
    const command: string[] = [];
    if (bin === "npm") {
      if (args.action === "install") command.push("install");
      else if (args.action === "add") command.push("install", ...(args.dev ? ["-D"] : []), ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "remove") command.push("uninstall", ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "update") command.push("update", ...(args.packages?.split(/\s+/) ?? []));
      else command.push(args.action);
    } else if (bin === "pnpm") {
      if (args.action === "install") command.push("install");
      else if (args.action === "add") command.push("add", ...(args.dev ? ["-D"] : []), ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "remove") command.push("remove", ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "update") command.push("update", ...(args.packages?.split(/\s+/) ?? []));
      else command.push(args.action);
    } else if (bin === "yarn") {
      if (args.action === "install") command.push("install");
      else if (args.action === "add") command.push("add", ...(args.dev ? ["-D"] : []), ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "remove") command.push("remove", ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "update") command.push("up", ...(args.packages?.split(/\s+/) ?? []));
      else command.push(args.action);
    } else {
      if (args.action === "install") command.push("install");
      else if (args.action === "add") command.push("add", ...(args.dev ? ["-d"] : []), ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "remove") command.push("remove", ...(args.packages?.split(/\s+/) ?? []));
      else if (args.action === "update") command.push("update", ...(args.packages?.split(/\s+/) ?? []));
      else command.push(args.action);
    }

    if (["add", "remove", "update"].includes(args.action) && !args.packages) throw new Error(`${args.action} requires packages`);
    const { stdout, stderr } = await execFileAsync(bin, command, {
      cwd: context.worktree,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, CI: process.env.CI || "1" },
    });
    return `${bin} ${command.join(" ")}\n${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.slice(-12000);
  },
});

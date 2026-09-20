import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 20000;
const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";

interface ToolSupportModule {
  parseShellLikeArgs(input?: string): string[];
  containsForcePushFlag(args: string[]): boolean;
}

async function loadSupport(): Promise<ToolSupportModule> {
  return import(pathToFileURL(path.join(DIST_ROOT, "app/services/agent-tool-support-service.js")).href) as Promise<ToolSupportModule>;
}

async function git(args: string[], worktree: string, timeout = 30000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: worktree,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return (stdout.trim() || stderr.trim() || "OK").slice(0, MAX_OUTPUT_CHARS);
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message?: string; code?: string | number };
    if (e.code === "ENOENT") throw new Error("git is not installed in this runtime.");
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    throw new Error((output || e.message || `Git command failed: git ${args.join(" ")}`).slice(0, MAX_OUTPUT_CHARS));
  }
}

export default tool({
  description: "Execute explicit Git operations in the current worktree without invoking a shell. Supports read operations plus commit, branch, checkout, stash, merge, rebase, fetch, pull, push, and reset. Force pushes are refused.",
  args: {
    action: tool.schema.enum([
      "status", "diff", "log", "commit", "push", "pull",
      "branch", "checkout", "stash", "merge", "rebase",
      "blame", "tags", "remote", "fetch", "reset",
    ]).describe("Git action to execute."),
    args: tool.schema.string().optional().describe("Additional git arguments. Quotes and backslash escapes are parsed without a shell."),
    message: tool.schema.string().optional().describe("Commit message for the commit action. Preferred over embedding -m in args."),
  },
  async execute(args, context) {
    const support = await loadSupport();
    const extra = support.parseShellLikeArgs(args.args);

    switch (args.action) {
      case "status":
        return git(["status", "--porcelain=v1", "--branch", ...extra], context.worktree);
      case "diff":
        return git(["diff", ...extra], context.worktree);
      case "log":
        return git(["log", "--oneline", "-20", ...extra], context.worktree);
      case "commit": {
        const message = args.message?.trim();
        if (message) return git(["commit", "-m", message, ...extra], context.worktree, 60000);
        if (!extra.length) throw new Error("commit requires message or args.");
        return git(["commit", ...extra], context.worktree, 60000);
      }
      case "push":
        if (support.containsForcePushFlag(extra)) {
          throw new Error("Refusing to force-push. Force pushes must be requested explicitly outside this tool.");
        }
        return git(["push", ...extra], context.worktree, 120000);
      case "pull":
        return git(["pull", ...extra], context.worktree, 120000);
      case "branch":
        return git(["branch", ...extra], context.worktree);
      case "checkout":
        return git(["checkout", ...extra], context.worktree, 60000);
      case "stash":
        return git(["stash", ...extra], context.worktree, 60000);
      case "merge":
        return git(["merge", ...extra], context.worktree, 120000);
      case "rebase":
        return git(["rebase", ...extra], context.worktree, 120000);
      case "blame":
        if (!extra.length) throw new Error('blame requires args, for example "src/file.ts".');
        return git(["blame", ...extra], context.worktree);
      case "tags":
        return git(["tag", "-l", ...extra], context.worktree);
      case "remote":
        return git(["remote", "-v", ...extra], context.worktree);
      case "fetch":
        return git(["fetch", ...extra], context.worktree, 120000);
      case "reset":
        return git(["reset", ...extra], context.worktree, 60000);
      default:
        throw new Error(`Unknown git action: ${args.action}`);
    }
  },
});
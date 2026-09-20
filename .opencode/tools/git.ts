import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

async function git(args: string[], worktree: string, timeout = 30000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: worktree,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim() || stderr.trim();
  } catch (error) {
    const e = error as { stderr?: string; message?: string; code?: string | number };
    if (e.code === "ENOENT") throw new Error("git is not installed. Install it with: apt-get install git");
    throw new Error(e.stderr || e.message || `Git command failed: git ${args.join(" ")}`);
  }
}

export default tool({
  description: "Execute git commands in the worktree. Supports status, diff, log, commit, push, pull, branch, checkout, stash, merge, rebase, blame, and tags.",
  args: {
    action: tool.schema.enum([
      "status", "diff", "log", "commit", "push", "pull",
      "branch", "checkout", "stash", "merge", "rebase",
      "blame", "tags", "remote", "fetch", "reset",
    ]).describe("Git action to execute."),
    args: tool.schema.string().optional().describe("Additional arguments for the git command (e.g., branch name, file path, commit message)."),
  },
  async execute(args, context) {
    const { action, args: extraArgs } = args;
    const worktree = context.worktree;
    const extra = extraArgs ? extraArgs.split(/\s+/) : [];

    switch (action) {
      case "status":
        return git(["status", "--porcelain"], worktree);
      case "diff":
        return git(["diff", ...extra], worktree);
      case "log":
        return git(["log", "--oneline", "-20", ...extra], worktree);
      case "commit": {
        if (!extra.length) throw new Error("Commit message required. Provide: args=\"-m 'your message'\" or args=\"your message\"");
        const isFlag = extra[0]?.startsWith("-");
        const commitArgs = isFlag ? ["commit", ...extra] : ["commit", "-m", extra.join(" ")];
        return git(commitArgs, worktree);
      }
      case "push":
        return git(["push", ...extra], worktree, 60000);
      case "pull":
        return git(["pull", ...extra], worktree, 60000);
      case "branch":
        return git(["branch", ...extra], worktree);
      case "checkout":
        return git(["checkout", ...extra], worktree);
      case "stash":
        return git(["stash", ...extra], worktree);
      case "merge":
        return git(["merge", ...extra], worktree);
      case "rebase":
        return git(["rebase", ...extra], worktree);
      case "blame":
        if (!extra.length) throw new Error("File path required for blame. Provide: args=\"path/to/file\"");
        return git(["blame", ...extra], worktree);
      case "tags":
        return git(["tag", "-l", ...extra], worktree);
      case "remote":
        return git(["remote", "-v", ...extra], worktree);
      case "fetch":
        return git(["fetch", ...extra], worktree, 60000);
      case "reset":
        return git(["reset", ...extra], worktree);
      default:
        throw new Error(`Unknown git action: ${action}`);
    }
  },
});

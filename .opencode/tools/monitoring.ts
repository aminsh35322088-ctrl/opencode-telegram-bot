import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

async function runCommand(cmd: string, args: string[], worktree: string, timeout = 30000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: worktree,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim() || stderr.trim();
  } catch (error) {
    const e = error as { stderr?: string; message?: string; code?: string | number };
    if (e.code === "ENOENT") throw new Error(`${cmd} is not installed. Install it first.`);
    throw new Error(e.stderr || e.message || `Command failed: ${cmd}`);
  }
}

export default tool({
  description: "Monitoring operations: tail logs, grep logs, health check, metrics, alerts.",
  args: {
    action: tool.schema.enum(["tail", "grep", "health", "metrics", "alerts"]).describe("Monitoring action to execute."),
    pattern: tool.schema.string().optional().describe("Search pattern for grep action."),
    lines: tool.schema.number().optional().describe("Number of lines to tail (default: 50)."),
    path: tool.schema.string().optional().describe("Log file path for tail/grep actions."),
  },
  async execute(args, context) {
    const { action, pattern, lines, path: logPath } = args;
    const worktree = context.worktree;
    const defaultLines = lines || 50;

    switch (action) {
      case "tail": {
        const logDir = logPath || path.join(worktree, "logs");
        try {
          const items = await fs.readdir(logDir);
          const logFiles = items.filter((f) => f.endsWith(".log") || f.endsWith(".txt") || f.endsWith(".jsonl"));
          if (!logFiles.length) return "No log files found in logs directory";

          const latest = logFiles.sort((a, b) => {
            try {
              return fs.stat(path.join(logDir, b)).then((s) => s.mtimeMs) as any;
            } catch {
              return 0;
            }
          })[0];

          const output = await runCommand("tail", ["-n", String(defaultLines), path.join(logDir, latest)], worktree);
          return `=== ${latest} (last ${defaultLines} lines) ===\n${output}`;
        } catch {
          return "Log directory not found or empty";
        }
      }
      case "grep": {
        if (!pattern) throw new Error("Pattern required for grep. Provide: pattern=\"ERROR\"");
        const logDir = logPath || path.join(worktree, "logs");
        try {
          const output = await runCommand("grep", ["-rn", pattern, logDir], worktree, 60000);
          return output.slice(0, 16000) || "No matches found";
        } catch (error) {
          const e = error as { code?: number };
          if (e.code === 1) return "No matches found";
          throw new Error("Grep failed. Check if log directory exists.");
        }
      }
      case "health": {
        const checks: string[] = [];

        try {
          await fs.access(path.join(worktree, "package.json"));
          checks.push("✅ package.json exists");
        } catch {
          checks.push("❌ package.json not found");
        }

        try {
          await fs.access(path.join(worktree, "node_modules"));
          checks.push("✅ node_modules exists");
        } catch {
          checks.push("⚠️ node_modules not found (may need npm install)");
        }

        try {
          const { stdout } = await execFileAsync("node", ["--version"], { cwd: worktree, timeout: 5000 });
          checks.push(`✅ Node.js ${stdout.trim()}`);
        } catch {
          checks.push("❌ Node.js not available");
        }

        try {
          const { stdout } = await execFileAsync("npm", ["--version"], { cwd: worktree, timeout: 5000 });
          checks.push(`✅ npm ${stdout.trim()}`);
        } catch {
          checks.push("❌ npm not available");
        }

        const pkg = JSON.parse(await fs.readFile(path.join(worktree, "package.json"), "utf-8").catch(() => "{}"));
        if (pkg.scripts?.build) checks.push("✅ Build script available");
        if (pkg.scripts?.test) checks.push("✅ Test script available");
        if (pkg.scripts?.lint) checks.push("✅ Lint script available");

        return checks.join("\n");
      }
      case "metrics": {
        const metrics: string[] = [];

        try {
          const stat = await fs.statfs("/data");
          const used = stat.blocks * stat.bsize;
          const total = stat.blocks * stat.bsize;
          const percent = Math.round((used / total) * 100);
          metrics.push(`Disk: ${percent}% used`);
        } catch {
          metrics.push("Disk: unavailable");
        }

        try {
          const { stdout } = await execFileAsync("ps", ["aux", "--sort=-%mem"], { cwd: worktree, timeout: 5000 });
          const lines = stdout.trim().split("\n").slice(1, 6);
          metrics.push(`Top processes:\n${lines.join("\n")}`);
        } catch {
          metrics.push("Process info: unavailable");
        }

        return metrics.join("\n\n");
      }
      case "alerts": {
        const alerts: string[] = [];

        try {
          const pkg = JSON.parse(await fs.readFile(path.join(worktree, "package.json"), "utf-8").catch(() => "{}"));
          if (pkg.devDependencies) {
            const deps = Object.keys(pkg.devDependencies);
            if (deps.length > 50) alerts.push(`⚠️ Many dev dependencies: ${deps.length}`);
          }
        } catch {}

        try {
          const { stdout } = await execFileAsync("find", [worktree, "-name", "*.log", "-size", "+10M"], {
            cwd: worktree,
            timeout: 10000,
          });
          const largeLogs = stdout.trim().split("\n").filter(Boolean);
          if (largeLogs.length) alerts.push(`⚠️ Large log files (>10MB): ${largeLogs.length}`);
        } catch {}

        try {
          const { stdout } = await execFileAsync("find", [worktree, "-name", "node_modules", "-prune", "-o", "-name", ".git", "-prune", "-o", "-type", "f", "-size", "+100M", "-print"], {
            cwd: worktree,
            timeout: 10000,
          });
          const largeFiles = stdout.trim().split("\n").filter(Boolean);
          if (largeFiles.length) alerts.push(`⚠️ Large files (>100MB): ${largeFiles.length}`);
        } catch {}

        return alerts.length
          ? `Alerts:\n${alerts.join("\n")}`
          : "No alerts";
      }
      default:
        throw new Error(`Unknown monitoring action: ${action}`);
    }
  },
});

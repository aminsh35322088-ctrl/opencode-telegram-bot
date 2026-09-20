import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 16000;
const MAX_FILES = 2000;
const LOG_EXTENSIONS = new Set([".log", ".txt", ".jsonl"]);

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function allowedTarget(worktree: string, raw?: string): string {
  const root = path.resolve(worktree);
  if (!raw?.trim()) return path.join(root, ".logs");
  const target = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const dataLogs = path.resolve("/data/logs");
  if (!inside(root, target) && !inside(dataLogs, target)) {
    throw new Error("Monitoring paths must stay inside the worktree or /data/logs.");
  }
  return target;
}

async function collectLogFiles(target: string): Promise<string[]> {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= MAX_FILES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && LOG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) results.push(full);
    }
  };
  await walk(target);
  return results;
}

async function tailFile(file: string, lines: number): Promise<string> {
  const text = await fs.readFile(file, "utf8");
  return text.split(/\r?\n/u).slice(-lines).join("\n").slice(0, MAX_OUTPUT_CHARS);
}

export default tool({
  description: "Bounded monitoring actions for application logs and host health: tail, grep, health, metrics, and alerts.",
  args: {
    action: tool.schema.enum(["tail", "grep", "health", "metrics", "alerts"]).describe("Monitoring action to execute."),
    pattern: tool.schema.string().optional().describe("Regular expression for grep."),
    lines: tool.schema.number().optional().describe("Number of lines for tail, default 50 and capped at 500."),
    path: tool.schema.string().optional().describe("Log file or directory. Must stay inside the worktree or /data/logs."),
  },
  async execute(args, context) {
    const worktree = path.resolve(context.worktree);
    const lineCount = Math.max(1, Math.min(Math.trunc(args.lines ?? 50), 500));

    if (args.action === "tail") {
      let target = allowedTarget(worktree, args.path);
      try {
        const stat = await fs.stat(target);
        if (stat.isDirectory()) {
          const files = await collectLogFiles(target);
          if (!files.length && !args.path) {
            for (const fallback of [path.join(worktree, "logs"), "/data/logs"]) {
              try {
                const fallbackFiles = await collectLogFiles(fallback);
                if (fallbackFiles.length) {
                  target = fallback;
                  files.push(...fallbackFiles);
                  break;
                }
              } catch {}
            }
          }
          if (!files.length) return "No log files found.";
          const withStats = await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file) })));
          withStats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
          const latest = withStats[0]!.file;
          return `=== ${path.relative(worktree, latest) || latest} (last ${lineCount} lines) ===\n${await tailFile(latest, lineCount)}`;
        }
        return `=== ${path.relative(worktree, target) || target} (last ${lineCount} lines) ===\n${await tailFile(target, lineCount)}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "Log path not found.";
        throw error;
      }
    }

    if (args.action === "grep") {
      if (!args.pattern?.trim()) throw new Error("grep requires pattern.");
      let matcher: RegExp;
      try {
        matcher = new RegExp(args.pattern, "i");
      } catch (error) {
        throw new Error(`Invalid grep regex: ${(error as Error).message}`);
      }
      const target = allowedTarget(worktree, args.path);
      let files: string[];
      try {
        files = await collectLogFiles(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No matching logs found.";
        throw error;
      }
      const matches: string[] = [];
      for (const file of files) {
        const text = await fs.readFile(file, "utf8").catch(() => "");
        const lines = text.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          if (matcher.test(lines[index] ?? "")) matches.push(`${file}:${index + 1}:${lines[index]}`);
          if (matches.join("\n").length >= MAX_OUTPUT_CHARS) break;
        }
        if (matches.join("\n").length >= MAX_OUTPUT_CHARS) break;
      }
      return matches.join("\n").slice(0, MAX_OUTPUT_CHARS) || "No matching logs found.";
    }

    if (args.action === "health") {
      const checks: string[] = [];
      for (const [label, target] of [["package.json", path.join(worktree, "package.json")], ["node_modules", path.join(worktree, "node_modules")]] as const) {
        try { await fs.access(target); checks.push(`✅ ${label} exists`); }
        catch { checks.push(`${label === "node_modules" ? "⚠️" : "❌"} ${label} not found`); }
      }
      for (const command of ["node", "npm"] as const) {
        try {
          const { stdout } = await execFileAsync(command, ["--version"], { cwd: worktree, timeout: 5000 });
          checks.push(`✅ ${command} ${stdout.trim()}`);
        } catch {
          checks.push(`❌ ${command} unavailable`);
        }
      }
      const pkg = JSON.parse(await fs.readFile(path.join(worktree, "package.json"), "utf8").catch(() => "{}")) as { scripts?: Record<string, string> };
      for (const script of ["build", "test", "lint", "typecheck"]) {
        if (pkg.scripts?.[script]) checks.push(`✅ ${script} script available`);
      }
      return checks.join("\n");
    }

    if (args.action === "metrics") {
      const metrics: string[] = [];
      try {
        const stat = await fs.statfs(worktree);
        const total = stat.blocks * stat.bsize;
        const free = stat.bavail * stat.bsize;
        const used = Math.max(0, total - free);
        const percent = total > 0 ? Math.round((used / total) * 100) : 0;
        metrics.push(`Disk: ${percent}% used (${Math.round(used / 1024 / 1024)} MiB / ${Math.round(total / 1024 / 1024)} MiB)`);
      } catch {
        metrics.push("Disk: unavailable");
      }
      try {
        const { stdout } = await execFileAsync("ps", ["aux", "--sort=-%mem"], { cwd: worktree, timeout: 5000, maxBuffer: 1024 * 1024 });
        metrics.push(`Top processes:\n${stdout.trim().split("\n").slice(0, 6).join("\n")}`);
      } catch {
        metrics.push("Process info: unavailable");
      }
      return metrics.join("\n\n").slice(0, MAX_OUTPUT_CHARS);
    }

    if (args.action === "alerts") {
      const alerts: string[] = [];
      try {
        const logRoots = [path.join(worktree, ".logs"), path.join(worktree, "logs"), "/data/logs"];
        let largeLogs = 0;
        for (const root of logRoots) {
          try {
            const files = await collectLogFiles(root);
            for (const file of files) if ((await fs.stat(file)).size > 10 * 1024 * 1024) largeLogs += 1;
          } catch {}
        }
        if (largeLogs) alerts.push(`⚠️ Large log files (>10 MiB): ${largeLogs}`);
      } catch {}
      try {
        const stat = await fs.statfs(worktree);
        const total = stat.blocks * stat.bsize;
        const free = stat.bavail * stat.bsize;
        const usedPercent = total > 0 ? ((total - free) / total) * 100 : 0;
        if (usedPercent >= 90) alerts.push(`⚠️ Disk usage is high: ${Math.round(usedPercent)}%`);
      } catch {}
      return alerts.length ? `Alerts:\n${alerts.join("\n")}` : "No alerts";
    }

    throw new Error(`Unknown monitoring action: ${args.action}`);
  },
});

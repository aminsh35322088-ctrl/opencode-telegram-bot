import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const MAX_SCAN_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 16000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveTarget(worktree: string, raw?: string): string {
  const root = path.resolve(worktree);
  const target = raw?.trim() ? path.resolve(root, raw) : root;
  if (!inside(root, target)) throw new Error("Security scan path must stay inside the current worktree.");
  return target;
}

async function npmJson(args: string[], worktree: string): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("npm", args, {
      cwd: worktree,
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: "true" },
    });
    return JSON.parse(stdout || "{}");
  } catch (error) {
    const e = error as { code?: string | number; stdout?: string; stderr?: string; message?: string };
    if (e.code === "ENOENT") throw new Error("npm is not installed in this runtime.");
    if (e.stdout?.trim()) {
      try { return JSON.parse(e.stdout); } catch {}
    }
    throw new Error(e.stderr || e.message || `npm ${args.join(" ")} failed`);
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (files.length >= MAX_SCAN_FILES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) break;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  await walk(root);
  return files;
}

export default tool({
  description: "Bounded security checks for the current worktree: potential-secret detection, npm audit, executable-file permissions, and outdated dependencies. Secret values are never returned.",
  args: {
    action: tool.schema.enum(["secrets", "audit", "permissions", "deps"]).describe("Security action to execute."),
    path: tool.schema.string().optional().describe("Relative path to inspect for secrets/permissions; defaults to worktree root."),
  },
  async execute(args, context) {
    const worktree = path.resolve(context.directory || context.worktree || process.cwd());
    const target = resolveTarget(worktree, args.path);

    if (args.action === "secrets") {
      const patterns = [
        { name: "AWS access key", regex: /AKIA[0-9A-Z]{16}/u },
        { name: "private key", regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/u },
        { name: "password assignment", regex: /password\s*[:=]\s*["'][^"'\r\n]+["']/iu },
        { name: "token assignment", regex: /token\s*[:=]\s*["'][^"'\r\n]+["']/iu },
        { name: "API key assignment", regex: /api[_-]?key\s*[:=]\s*["'][^"'\r\n]+["']/iu },
        { name: "secret assignment", regex: /secret\s*[:=]\s*["'][^"'\r\n]+["']/iu },
      ];
      const findings: string[] = [];
      const files = await walkFiles(target);
      for (const file of files) {
        const stat = await fs.stat(file).catch(() => null);
        if (!stat || stat.size > MAX_FILE_BYTES) continue;
        const text = await fs.readFile(file, "utf8").catch(() => "");
        if (!text) continue;
        for (const pattern of patterns) {
          if (pattern.regex.test(text)) findings.push(`${path.relative(worktree, file)}: potential ${pattern.name}`);
        }
        if (findings.join("\n").length >= MAX_OUTPUT_CHARS) break;
      }
      return findings.length
        ? `Found ${findings.length} potential secret locations (values redacted):\n${findings.join("\n").slice(0, MAX_OUTPUT_CHARS)}`
        : "No obvious secrets found in the bounded scan.";
    }

    if (args.action === "audit") {
      const audit = await npmJson(["audit", "--json"], worktree) as { metadata?: { vulnerabilities?: Record<string, number> } };
      const vuln = audit.metadata?.vulnerabilities ?? {};
      const summary = ["critical", "high", "moderate", "low", "info"]
        .map((level) => [level, Number(vuln[level] ?? 0)] as const)
        .filter(([, count]) => count > 0)
        .map(([level, count]) => `${level}: ${count}`)
        .join(", ");
      return summary ? `npm audit vulnerabilities — ${summary}` : "npm audit reports no vulnerabilities.";
    }

    if (args.action === "permissions") {
      const files = await walkFiles(target);
      const executable: string[] = [];
      for (const file of files) {
        const stat = await fs.stat(file).catch(() => null);
        if (stat && (stat.mode & 0o111) !== 0) executable.push(path.relative(worktree, file));
      }
      return executable.length
        ? `Executable files (${executable.length}):\n${executable.slice(0, 100).join("\n")}`
        : "No executable files found in the bounded scan.";
    }

    if (args.action === "deps") {
      const outdated = await npmJson(["outdated", "--json"], worktree) as Record<string, { current?: string; latest?: string; wanted?: string }>;
      const entries = Object.entries(outdated);
      if (!entries.length) return "All npm dependencies are up to date.";
      return `Outdated dependencies (${entries.length}):\n${entries.slice(0, 100).map(([name, info]) => `${name}: ${info.current ?? "?"} -> ${info.latest ?? info.wanted ?? "?"}`).join("\n")}`;
    }

    throw new Error(`Unknown security action: ${args.action}`);
  },
});

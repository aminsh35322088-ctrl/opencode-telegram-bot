import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;

function apiUrl(): string {
  return (process.env.OPENCODE_API_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD || "";
  if (!password) return {};
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

function timeoutMs(value?: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(value, MAX_TIMEOUT_MS);
}

async function httpCheck(endpoint: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${apiUrl()}${endpoint}`, {
      method: "GET",
      headers: authHeaders(),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
    }
    return { ok: response.ok, status: response.status, elapsedMs: Date.now() - started, body };
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function command(bin: string, args: string[], cwd: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const result = await execFileAsync(bin, args, { cwd, timeout: timeoutMs(), maxBuffer: 512 * 1024, signal, killSignal: "SIGTERM" });
    return { ok: true, output: result.stdout.trim().slice(0, 2000) };
  } catch (error) {
    const e = error as { code?: string | number; stdout?: string; stderr?: string; message?: string };
    return { ok: false, code: e.code ?? "unknown", output: (e.stderr || e.stdout || e.message || "").trim().slice(0, 2000) };
  }
}

async function packageCheck(worktree: string): Promise<Record<string, unknown>> {
  const packagePath = path.join(worktree, "package.json");
  try {
    const raw = await fs.readFile(packagePath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; packageManager?: string };
    const scripts = pkg.scripts ?? {};
    return {
      ok: true,
      packageJson: packagePath,
      packageManager: pkg.packageManager || "npm (default)",
      scripts: {
        test: Boolean(scripts.test),
        build: Boolean(scripts.build),
        lint: Boolean(scripts.lint),
        typecheck: Boolean(scripts.typecheck),
      },
      nodeModulesPresent: await fs.access(path.join(worktree, "node_modules")).then(() => true).catch(() => false),
    };
  } catch (error) {
    return { ok: false, packageJson: packagePath, error: error instanceof Error ? error.message : String(error) };
  }
}

export default tool({
  description: "Run a bounded, read-only health check across OpenCode API reachability, session status, runtime resources, project validation readiness, and core executables. Use this before recovery or repeated testing; it never installs packages, mutates files, aborts sessions, or retries indefinitely.",
  args: {
    sessionId: tool.schema.string().optional().describe("Optional OpenCode session ID to inspect."),
    timeoutMs: tool.schema.number().optional().describe("Per-check timeout in milliseconds, capped at 15000."),
    detail: tool.schema.enum(["quick", "full"]).optional().describe("quick checks core health; full also checks project files, disk, and executables."),
  },
  async execute(args, context) {
    const started = Date.now();
    const detail = args.detail ?? "full";
    const result: Record<string, unknown> = {
      ok: true,
      mode: detail,
      opencode: { address: apiUrl() },
      checks: {},
    };
    const checks = result.checks as Record<string, unknown>;

    const health = await httpCheck("/global/health", context.abort);
    checks.opencodeHealth = health;
    if (!health.ok) {
      const fallback = await httpCheck("/", context.abort);
      checks.opencodeRoot = fallback;
      if (!fallback.ok) result.ok = false;
    }

    if (args.sessionId) {
      const sessions = await httpCheck("/session/status", context.abort);
      let sessionState = "unknown";
      if (sessions.ok && typeof sessions.body === "object" && sessions.body !== null) {
        const direct = (sessions.body as Record<string, unknown>)[args.sessionId];
        if (typeof direct === "object" && direct !== null && typeof (direct as Record<string, unknown>).type === "string") {
          sessionState = (direct as Record<string, string>).type;
        }
      }
      checks.session = { ...sessions, sessionId: args.sessionId, state: sessionState };
      if (!sessions.ok) result.ok = false;
    }

    const memTotal = os.totalmem();
    const memFree = os.freemem();
    checks.runtime = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg(),
      processUptimeSec: Math.round(process.uptime()),
      memory: { totalBytes: memTotal, freeBytes: memFree, usedBytes: memTotal - memFree },
    };

    if (detail === "full") {
      checks.project = await packageCheck(context.worktree);
      const disk = await command("df", ["-h", "/data"], context.worktree, context.abort);
      checks.disk = disk;
      const tools: Record<string, unknown> = {};
      for (const [name, argsList] of [["node", ["--version"]], ["npm", ["--version"]], ["git", ["--version"]], ["tsc", ["--version"]], ["vitest", ["--version"]], ["eslint", ["--version"]]] as const) {
        tools[name] = await command(name, argsList, context.worktree, context.abort);
      }
      checks.executables = tools;
    }

    result.elapsedMs = Date.now() - started;
    return JSON.stringify(result, null, 2).slice(0, 16000);
  },
});

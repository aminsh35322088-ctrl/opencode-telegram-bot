import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const dataRoot = "/data";
const budgetBytes = Number(process.env.OPENCODE_DATA_VOLUME_BUDGET_MB ?? 500) * 1024 * 1024;
const warningBytes = Number(process.env.OPENCODE_DATA_VOLUME_WARN_MB ?? 150) * 1024 * 1024;
const criticalBytes = Number(process.env.OPENCODE_DATA_VOLUME_CRITICAL_MB ?? 100) * 1024 * 1024;
const safeCachePaths = [
  "/data/.cache/npm",
  "/data/.npm",
  "/data/.cache/opencode",
  "/data/.cache/tsx",
];

async function freeBytes(): Promise<number> {
  const stats = await fs.statfs(dataRoot);
  return stats.bavail * stats.bsize;
}

async function sizeOf(target: string): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(current)) {
        await walk(path.join(current, entry));
      }
      return;
    }
    total += stat.size;
  }
  try { await walk(target); } catch { return 0; }
  return total;
}

function statusFor(free: number): "healthy" | "warning" | "critical" {
  if (free < criticalBytes) return "critical";
  if (free < warningBytes) return "warning";
  return "healthy";
}

export default tool({
  description: "Inspect and safely reclaim persistent /data volume space. Never deletes user workspaces, sessions, databases, or source files.",
  args: {
    action: tool.schema.enum(["inspect", "cleanup-safe"]).optional().describe("Inspect usage or remove only disposable package/tool caches."),
  },
  async execute(args) {
    const action = args.action ?? "inspect";
    const before = await freeBytes();
    const result: Record<string, unknown> = {
      mount: dataRoot,
      configuredBudgetMb: Math.round(budgetBytes / 1024 / 1024),
      freeMb: Math.floor(before / 1024 / 1024),
      status: statusFor(before),
      safeCachePaths: [],
    };

    const caches: Array<{ path: string; bytes: number }> = [];
    for (const cachePath of safeCachePaths) {
      const bytes = await sizeOf(cachePath);
      if (bytes > 0) caches.push({ path: cachePath, bytes });
    }
    result.safeCachePaths = caches;

    if (action === "cleanup-safe") {
      for (const cachePath of safeCachePaths) await fs.rm(cachePath, { recursive: true, force: true });
      const after = await freeBytes();
      result.cleaned = caches.map((item) => item.path);
      result.reclaimedMb = Math.max(0, Math.floor((after - before) / 1024 / 1024));
      result.freeMbAfter = Math.floor(after / 1024 / 1024);
      result.statusAfter = statusFor(after);
    }

    if (before < criticalBytes && action !== "cleanup-safe") {
      result.nextAction = "Run cleanup-safe immediately; do not install packages or start disk-heavy validation.";
    } else if (before < warningBytes) {
      result.nextAction = "Keep validation temporary files in /tmp and avoid persistent downloads.";
    } else {
      result.nextAction = "Normal operation; keep generated artifacts and caches off /data when possible.";
    }

    return JSON.stringify(result, null, 2).slice(0, 16000);
  },
});

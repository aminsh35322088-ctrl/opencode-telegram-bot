import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const MAX_LINES = 500;

async function collect(dir: string, out: string[], remaining: { value: number }, pattern?: string) {
  if (remaining.value <= 0) return;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (remaining.value <= 0) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await collect(full, out, remaining, pattern); continue; }
    if (!entry.isFile()) continue;
    if (!/\.(log|txt)$/i.test(entry.name)) continue;
    const text = await fs.readFile(full, "utf8").catch(() => "");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const selected = pattern ? lines.filter((line) => line.toLowerCase().includes(pattern.toLowerCase())) : lines;
    for (const line of selected.slice(-remaining.value)) { out.push(`${full}: ${line}`); remaining.value--; }
  }
}

export default tool({
  description: "Inspect recent application/runtime logs under /data/logs and the current workspace. Use for debugging crashes, deployment issues, and recurring errors.",
  args: {
    pattern: tool.schema.string().optional().describe("Optional case-insensitive text filter."),
    lines: tool.schema.number().optional().describe("Maximum lines to return, default 100, capped at 500."),
  },
  async execute(args, context) {
    const out: string[] = [];
    const remaining = { value: Math.max(1, Math.min(args.lines ?? 100, MAX_LINES)) };
    await collect("/data/logs", out, remaining, args.pattern);
    if (remaining.value > 0) await collect(path.join(context.worktree, ".logs"), out, remaining, args.pattern);
    return out.length ? out.join("\n").slice(0, 20000) : "No matching logs found.";
  },
});

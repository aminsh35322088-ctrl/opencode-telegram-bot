import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

async function command(bin: string, args: string[]): Promise<string> {
  try { return (await execFileAsync(bin, args, { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch { return "unavailable"; }
}

export default tool({
  description: "Inspect CPU, memory, uptime, filesystem capacity, and running processes in the current Railway container.",
  args: {
    detail: tool.schema.enum(["summary", "processes", "disk"]).optional().describe("Detail level."),
  },
  async execute(args) {
    const detail = args.detail ?? "summary";
    const mem = { totalBytes: os.totalmem(), freeBytes: os.freemem(), usedBytes: os.totalmem() - os.freemem() };
    const result: Record<string, unknown> = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg(),
      uptimeSec: os.uptime(),
      processUptimeSec: process.uptime(),
      memory: mem,
    };
    if (detail === "disk") result.disk = await command("df", ["-h", "/data"]);
    if (detail === "processes") result.processes = await command("ps", ["-eo", "pid,ppid,%cpu,%mem,rss,etime,cmd", "--sort=-%cpu"]);
    if (detail === "summary") {
      try { result.dataFree = (await fs.statfs("/data")).bavail * (await fs.statfs("/data")).bsize; } catch { /* optional */ }
    }
    return JSON.stringify(result, null, 2).slice(0, 16000);
  },
});

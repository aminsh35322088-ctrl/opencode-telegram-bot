import type { ToolProcessPort } from "@opencode-telegram/native-runtime";
import { promises as fs } from "node:fs";
import os from "node:os";
import { tool } from "@opencode-ai/plugin";


async function command(processPort: ToolProcessPort, bin: string, args: string[]): Promise<string> {
  try { return (await processPort.execFile(bin, args, { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch { return "unavailable"; }
}

export default tool({
  description: "Inspect the current bot container through explicit summary, processes, or disk actions.",
  args: {
    action: tool.schema.enum(["summary", "processes", "disk"]).describe("System diagnostics action to execute."),
  },
  async execute(args, context) {
    const processPort = (context as typeof context & { process?: ToolProcessPort }).process;
    if (!processPort) throw new Error("Core process capability is required for tool ownership.");
    const action = args.action;
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
    if (action === "disk") result.disk = await command(processPort, "df", ["-h", "/data"]);
    if (action === "processes") result.processes = await command(processPort, "ps", ["-eo", "pid,ppid,%cpu,%mem,rss,etime,cmd", "--sort=-%cpu"]);
    if (action === "summary") {
      try { result.dataFree = (await fs.statfs("/data")).bavail * (await fs.statfs("/data")).bsize; } catch { /* optional */ }
    }
    return JSON.stringify(result, null, 2).slice(0, 16000);
  },
});

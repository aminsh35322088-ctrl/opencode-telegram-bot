import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";
interface TailscaleModule {
  getTailscaleRuntimeStatus(): Promise<Record<string, unknown>>;
  listTailscaleSshDevices(): Promise<Array<Record<string, unknown>>>;
  pingTailscaleSshDevice(target: string): Promise<Record<string, unknown>>;
}
async function service(): Promise<TailscaleModule> {
  return import(pathToFileURL(path.join(DIST_ROOT, "app/services/tailscale-integration-service.js")).href) as Promise<TailscaleModule>;
}
function output(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 30000); }

export default tool({
  description:
    "Inspect the bot's Tailnet connection and the SSH-capable peers allowed by tag:ssh. Device discovery is automatic from Tailscale; this tool cannot add arbitrary SSH servers or credentials.",
  args: {
    action: tool.schema.enum(["status", "devices", "ping"]).describe("Tailnet operation."),
    target: tool.schema.string().optional().describe("For ping: visible tag:ssh Tailnet hostname, MagicDNS name, or Tailscale IP."),
  },
  async execute(args) {
    const tailscale = await service();
    if (args.action === "status") return output(await tailscale.getTailscaleRuntimeStatus());
    if (args.action === "devices") return output({ ok: true, devices: await tailscale.listTailscaleSshDevices() });
    const target = args.target?.trim();
    if (!target) throw new Error("ping requires target.");
    return output(await tailscale.pingTailscaleSshDevice(target));
  },
});

import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";
interface TailscaleModule {
  getTailscaleRuntimeStatus(): Promise<Record<string, unknown>>;
  listTailscaleDevices(): Promise<Array<Record<string, unknown>>>;
  pingTailscaleSshDevice(target: string): Promise<Record<string, unknown>>;
}
async function service(): Promise<TailscaleModule> {
  return import(pathToFileURL(path.join(DIST_ROOT, "app/services/tailscale-integration-service.js")).href) as Promise<TailscaleModule>;
}
function output(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 30000); }

export default tool({
  description:
    "Inspect the bot's Tailnet connection and all peers visible in its current Tailscale netmap. Device discovery reports tags, online state, SSH eligibility, and the reason a visible peer is not eligible. SSH execution still requires an online tag:ssh peer.",
  args: {
    action: tool.schema.enum(["status", "devices", "ping"]).describe("Tailnet operation."),
    target: tool.schema.string().optional().describe("For ping: visible tag:ssh Tailnet hostname, MagicDNS name, or Tailscale IP."),
  },
  async execute(args) {
    const tailscale = await service();
    if (args.action === "status") return output(await tailscale.getTailscaleRuntimeStatus());
    if (args.action === "devices") {
      const devices = await tailscale.listTailscaleDevices();
      return output({
        ok: true,
        visiblePeers: devices.length,
        sshEligible: devices.filter((device) => device.sshEligible === true).length,
        devices,
      });
    }
    const target = args.target?.trim();
    if (!target) throw new Error("ping requires target.");
    return output(await tailscale.pingTailscaleSshDevice(target));
  },
});

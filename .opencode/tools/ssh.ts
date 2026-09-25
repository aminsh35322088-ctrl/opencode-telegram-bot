import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";

interface SshModule {
  checkSshTarget(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugSshTarget(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  execSshCommand(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function service(): Promise<SshModule> {
  return import(pathToFileURL(path.join(DIST_ROOT, "app/services/ssh-service.js")).href) as Promise<SshModule>;
}

function output(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 30000);
}

export default tool({
  description:
    "Adaptive SSH access for direct hosts and Tailscale peers. check performs a bounded reachability probe, debug diagnoses DNS/tailnet/SSH handshake problems without exposing credentials, and exec runs a remote command. Direct SSH keeps normal algorithm negotiation. Tailscale SSH only falls back to ecdh-sha2-nistp256 when the default handshake stalls or has a KEX mismatch.",
  args: {
    action: tool.schema.enum(["check", "debug", "exec"]).describe("SSH operation."),
    host: tool.schema.string().describe("Hostname, MagicDNS name, or IP address."),
    user: tool.schema.string().optional().describe("Remote SSH user. Required for debug and exec."),
    port: tool.schema.number().optional().describe("SSH port, default 22."),
    transport: tool.schema.enum(["auto", "tailscale", "direct"]).optional().describe("Transport selection. auto detects Tailnet peers first."),
    compatibility: tool.schema.enum(["auto", "default", "ecdh-nistp256"]).optional().describe("Handshake compatibility. auto only applies the known Tailscale KEX fallback when needed."),
    timeoutMs: tool.schema.number().optional().describe("Per-attempt timeout in milliseconds, 3000-60000; default 15000."),
    depth: tool.schema.enum(["basic", "handshake", "full"]).optional().describe("For debug: diagnostic depth. full includes sanitized SSH logs."),
    command: tool.schema.string().optional().describe("For exec: remote command to run. Credentials must never be embedded here."),
  },
  async execute(args) {
    const ssh = await service();
    const common = {
      host: args.host,
      user: args.user,
      port: args.port,
      transport: args.transport,
      compatibility: args.compatibility,
      timeoutMs: args.timeoutMs,
    };
    if (args.action === "check") return output(await ssh.checkSshTarget(common));
    if (args.action === "debug") return output(await ssh.debugSshTarget({ ...common, depth: args.depth }));
    if (!args.command?.trim()) throw new Error("exec requires command.");
    return output(await ssh.execSshCommand({ ...common, command: args.command }));
  },
});

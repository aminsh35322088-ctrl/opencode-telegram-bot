import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";

interface SshModule {
  checkTailnetSsh(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugTailnetSsh(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  execTailnetSsh(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  transferTailnetSshFile(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}
async function service(): Promise<SshModule> {
  return import(pathToFileURL(path.join(DIST_ROOT, "app/services/ssh-service.js")).href) as Promise<SshModule>;
}
function output(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 30000); }
function clean(value?: string): string | undefined { const v = value?.trim(); return v ? v : undefined; }
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function uploadSource(worktree: string, raw: string): Promise<string> {
  if (!raw.trim() || path.isAbsolute(raw)) throw new Error("local_path must be relative to the current worktree.");
  const root = await fs.realpath(path.resolve(worktree)).catch(() => path.resolve(worktree));
  const actual = await fs.realpath(path.resolve(root, raw));
  if (!inside(root, actual)) throw new Error("Upload source escapes the current worktree.");
  if (!(await fs.stat(actual)).isFile()) throw new Error("Upload source must be a regular file.");
  return actual;
}
async function downloadDestination(worktree: string, raw: string, overwrite: boolean): Promise<string> {
  if (!raw.trim() || path.isAbsolute(raw)) throw new Error("local_path must be relative to the current worktree.");
  const root = await fs.realpath(path.resolve(worktree)).catch(() => path.resolve(worktree));
  const target = path.resolve(root, raw);
  if (!inside(root, target)) throw new Error("Download destination escapes the current worktree.");
  let cursor = path.dirname(target);
  while (true) {
    try {
      const actual = await fs.realpath(cursor);
      if (!inside(root, actual)) throw new Error("Download destination escapes through a symlink.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error("Could not resolve a safe download destination.");
      cursor = parent;
    }
  }
  if (!overwrite && await fs.access(target).then(() => true).catch(() => false)) {
    throw new Error("Download destination already exists. Pass overwrite=true to replace it.");
  }
  return target;
}

export default tool({
  description:
    "SSH only to Tailnet peers that are currently visible and tagged tag:ssh. Direct Internet/LAN SSH, passwords, private keys, arbitrary hosts, and saved SSH profiles are intentionally unsupported. The service uses Tailscale userspace networking and applies a per-connection KEX fallback only when the default Tailscale SSH handshake stalls.",
  args: {
    action: tool.schema.enum(["check", "debug", "exec", "upload", "download"]).describe("SSH operation."),
    target: tool.schema.string().describe("Tailnet hostname, MagicDNS name, or Tailscale IP of a visible tag:ssh peer."),
    user: tool.schema.string().describe("Remote OS username, for example runner or ubuntu."),
    timeoutMs: tool.schema.number().optional().describe("Per-attempt timeout in milliseconds, bounded to 3000-60000."),
    command: tool.schema.string().optional().describe("Remote command for exec. Never include credentials."),
    local_path: tool.schema.string().optional().describe("Worktree-relative local path for upload/download."),
    remote_path: tool.schema.string().optional().describe("Remote file path for upload/download."),
    overwrite: tool.schema.boolean().optional().describe("Allow download to replace an existing worktree file."),
  },
  async execute(args, context) {
    const ssh = await service();
    const target = clean(args.target);
    const user = clean(args.user);
    if (!target || !user) throw new Error("SSH actions require target and user.");

    const common = { target, user, timeoutMs: args.timeoutMs };
    if (args.action === "check") return output(await ssh.checkTailnetSsh(common));
    if (args.action === "debug") return output(await ssh.debugTailnetSsh(common));
    if (args.action === "exec") {
      const command = args.command?.trim();
      if (!command) throw new Error("exec requires command.");
      return output(await ssh.execTailnetSsh({ ...common, command }));
    }

    const local = clean(args.local_path);
    const remote = clean(args.remote_path);
    if (!local || !remote) throw new Error(`${args.action} requires local_path and remote_path.`);
    const worktree = path.resolve(context.directory || context.worktree || process.cwd());
    const localPath = args.action === "upload"
      ? await uploadSource(worktree, local)
      : await downloadDestination(worktree, local, args.overwrite === true);
    return output(await ssh.transferTailnetSshFile({
      ...common,
      localPath,
      remotePath: remote,
      direction: args.action,
    }));
  },
});

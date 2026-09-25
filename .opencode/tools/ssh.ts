import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";

interface SshActionModule {
  sshProfilesList(): Promise<Record<string, unknown>>;
  sshProfilesGet(id: string): Promise<Record<string, unknown>>;
  sshProfilesCreate(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  sshProfilesUpdate(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  sshProfilesDelete(id: string): Promise<Record<string, unknown>>;
  sshCredentialsStatus(): Promise<Record<string, unknown>>;
  sshTailnetStatus(): Promise<Record<string, unknown>>;
  sshTailnetPing(target: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  sshCheck(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  sshDebug(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  sshExec(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  sshTransfer(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function service(): Promise<SshActionModule> {
  return import(pathToFileURL(path.join(DIST_ROOT, "app/services/ssh-action-service.js")).href) as Promise<SshActionModule>;
}

function output(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 30000);
}

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function commonTarget(args: {
  profile_id?: string;
  host?: string;
  user?: string;
  port?: number;
  transport?: "auto" | "tailscale" | "direct";
  compatibility?: "auto" | "default" | "ecdh-nistp256";
  credential_id?: string;
  timeoutMs?: number;
}): Record<string, unknown> {
  return {
    profileId: clean(args.profile_id),
    host: clean(args.host),
    user: clean(args.user),
    port: args.port,
    transport: args.transport,
    compatibility: args.compatibility,
    credentialId: clean(args.credential_id),
    timeoutMs: args.timeoutMs,
  };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveUploadSource(worktree: string, raw: string): Promise<string> {
  if (!raw.trim() || path.isAbsolute(raw)) throw new Error("local_path must be relative to the current worktree.");
  const root = await fs.realpath(path.resolve(worktree)).catch(() => path.resolve(worktree));
  const requested = path.resolve(root, raw);
  const actual = await fs.realpath(requested);
  if (!inside(root, actual)) throw new Error("Upload source escapes the current worktree.");
  const stat = await fs.stat(actual);
  if (!stat.isFile()) throw new Error("Upload source must be a regular file.");
  return actual;
}

async function resolveDownloadDestination(worktree: string, raw: string, overwrite: boolean): Promise<string> {
  if (!raw.trim() || path.isAbsolute(raw)) throw new Error("local_path must be relative to the current worktree.");
  const root = await fs.realpath(path.resolve(worktree)).catch(() => path.resolve(worktree));
  const requested = path.resolve(root, raw);
  if (!inside(root, requested)) throw new Error("Download destination escapes the current worktree.");

  let cursor = path.dirname(requested);
  while (true) {
    try {
      const actualParent = await fs.realpath(cursor);
      if (!inside(root, actualParent)) throw new Error("Download destination escapes through a symlink.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error("Could not resolve a safe download destination.");
      cursor = parent;
    }
  }

  if (!overwrite) {
    const exists = await fs.access(requested).then(() => true).catch(() => false);
    if (exists) throw new Error("Download destination already exists. Pass overwrite=true to replace it.");
  }
  return requested;
}

export default tool({
  description:
    "Profile-aware SSH and Tailnet control. Manage non-secret server profiles, inspect stored credential metadata, check/debug/execute SSH, transfer files, and inspect/ping Tailscale peers. Secrets are never accepted by this tool; provision them separately through the secure console credential helper.",
  args: {
    action: tool.schema.enum([
      "tailnet.status",
      "tailnet.ping",
      "profiles.list",
      "profiles.get",
      "profiles.create",
      "profiles.update",
      "profiles.delete",
      "credentials.status",
      "check",
      "debug",
      "exec",
      "upload",
      "download",
    ]).describe("SSH/Tailnet action."),

    profile_id: tool.schema.string().optional().describe("Saved SSH profile id. When supplied, host/user/transport/credential overrides are rejected."),
    name: tool.schema.string().optional().describe("Profile display name for profiles.create/update."),
    host: tool.schema.string().optional().describe("Ad-hoc hostname/IP, or profile host for profiles.create/update."),
    user: tool.schema.string().optional().describe("Remote SSH user, or profile user for profiles.create/update."),
    port: tool.schema.number().optional().describe("SSH port, default 22."),
    transport: tool.schema.enum(["auto", "tailscale", "direct"]).optional().describe("Transport selection; auto uses Tailnet when the peer is visible."),
    compatibility: tool.schema.enum(["auto", "default", "ecdh-nistp256"]).optional().describe("Handshake compatibility. auto keeps default negotiation and uses the known Tailscale KEX fallback only when needed."),
    credential_id: tool.schema.string().optional().describe("Reference to a securely stored SSH credential. The secret itself is never model-facing."),
    timeoutMs: tool.schema.number().optional().describe("Per-attempt timeout in ms, bounded by the SSH service."),

    target: tool.schema.string().optional().describe("Target hostname/IP for tailnet.ping."),
    depth: tool.schema.enum(["basic", "handshake", "full"]).optional().describe("debug diagnostic depth. full includes sanitized SSH logs."),
    command: tool.schema.string().optional().describe("Remote command for exec. Never include passwords, tokens, private keys, or 2FA codes."),
    local_path: tool.schema.string().optional().describe("Worktree-relative local file path for upload/download."),
    remote_path: tool.schema.string().optional().describe("Remote file path for upload/download."),
    overwrite: tool.schema.boolean().optional().describe("Allow download to replace an existing worktree file."),
    confirm: tool.schema.boolean().optional().describe("Required as true for profiles.delete."),
  },

  async execute(args, context) {
    const ssh = await service();
    const action = args.action;

    if (action === "tailnet.status") return output(await ssh.sshTailnetStatus());
    if (action === "tailnet.ping") {
      const target = clean(args.target);
      if (!target) throw new Error("tailnet.ping requires target.");
      return output(await ssh.sshTailnetPing(target, args.timeoutMs));
    }

    if (action === "profiles.list") return output(await ssh.sshProfilesList());
    if (action === "credentials.status") return output(await ssh.sshCredentialsStatus());

    if (action === "profiles.get") {
      const id = clean(args.profile_id);
      if (!id) throw new Error("profiles.get requires profile_id.");
      return output(await ssh.sshProfilesGet(id));
    }

    if (action === "profiles.create") {
      const name = clean(args.name);
      const host = clean(args.host);
      const user = clean(args.user);
      if (!name || !host || !user) throw new Error("profiles.create requires name, host, and user.");
      return output(await ssh.sshProfilesCreate({
        id: clean(args.profile_id),
        name,
        host,
        user,
        port: args.port,
        transport: args.transport,
        compatibility: args.compatibility,
        credentialId: clean(args.credential_id),
      }));
    }

    if (action === "profiles.update") {
      const id = clean(args.profile_id);
      if (!id) throw new Error("profiles.update requires profile_id.");
      const patch: Record<string, unknown> = {};
      if (clean(args.name)) patch.name = clean(args.name);
      if (clean(args.host)) patch.host = clean(args.host);
      if (clean(args.user)) patch.user = clean(args.user);
      if (args.port !== undefined) patch.port = args.port;
      if (args.transport !== undefined) patch.transport = args.transport;
      if (args.compatibility !== undefined) patch.compatibility = args.compatibility;
      if (args.credential_id !== undefined) patch.credentialId = args.credential_id.trim();
      if (Object.keys(patch).length === 0) throw new Error("profiles.update requires at least one field to change.");
      return output(await ssh.sshProfilesUpdate(id, patch));
    }

    if (action === "profiles.delete") {
      const id = clean(args.profile_id);
      if (!id) throw new Error("profiles.delete requires profile_id.");
      if (args.confirm !== true) throw new Error("profiles.delete requires confirm=true.");
      return output(await ssh.sshProfilesDelete(id));
    }

    const profileId = clean(args.profile_id);
    if (!profileId) throw new Error(`${action} requires profile_id. Model-facing SSH execution is restricted to saved allowlisted profiles.`);
    const target = { profileId, timeoutMs: args.timeoutMs };

    if (action === "check") return output(await ssh.sshCheck(target));
    if (action === "debug") return output(await ssh.sshDebug({ ...target, depth: args.depth }));

    if (action === "exec") {
      const command = args.command?.trim();
      if (!command) throw new Error("exec requires command.");
      return output(await ssh.sshExec({ ...target, command }));
    }

    const local = clean(args.local_path);
    const remote = clean(args.remote_path);
    if (!local || !remote) throw new Error(`${action} requires local_path and remote_path.`);
    const worktree = path.resolve(context.directory || context.worktree || process.cwd());
    const localPath = action === "upload"
      ? await resolveUploadSource(worktree, local)
      : await resolveDownloadDestination(worktree, local, args.overwrite === true);

    return output(await ssh.sshTransfer({
      ...target,
      localPath,
      remotePath: remote,
      direction: action,
    }));
  },
});

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";

interface SshTargetDescription {
  hostname: string;
  dnsName?: string;
  ips: string[];
  os?: string;
  identity: string;
  username: string;
  port: number;
  scope: string;
  authentication: string;
  passwordRequired: false;
  remoteWorkspace?: string;
}

interface SshModule {
  resolveTailnetSshScope(sessionId: string): Promise<string>;
  describeTailnetSshTarget(input: Record<string, unknown>): Promise<SshTargetDescription>;
  hasActiveTailnetSshConnection(input: Record<string, unknown>): Promise<boolean>;
  hasTailnetSshAuthorization(input: Record<string, unknown>): Promise<boolean>;
  grantTailnetSshAuthorization(input: Record<string, unknown>): Promise<void>;
  checkTailnetSsh(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugTailnetSsh(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  execTailnetSsh(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  transferTailnetSshFile(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function service(): Promise<SshModule> {
  return import(
    pathToFileURL(path.join(DIST_ROOT, "app/services/ssh-service.js")).href
  ) as Promise<SshModule>;
}

function output(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 30000);
}

function clean(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function uploadSource(worktree: string, raw: string): Promise<string> {
  if (!raw.trim() || path.isAbsolute(raw)) {
    throw new Error("local_path must be relative to the current worktree.");
  }
  const root = await fs.realpath(path.resolve(worktree)).catch(() => path.resolve(worktree));
  const actual = await fs.realpath(path.resolve(root, raw));
  if (!inside(root, actual)) throw new Error("Upload source escapes the current worktree.");
  if (!(await fs.stat(actual)).isFile()) throw new Error("Upload source must be a regular file.");
  return actual;
}

async function downloadDestination(
  worktree: string,
  raw: string,
  overwrite: boolean,
): Promise<string> {
  if (!raw.trim() || path.isAbsolute(raw)) {
    throw new Error("local_path must be relative to the current worktree.");
  }
  const root = await fs.realpath(path.resolve(worktree)).catch(() => path.resolve(worktree));
  const target = path.resolve(root, raw);
  if (!inside(root, target)) throw new Error("Download destination escapes the current worktree.");

  let cursor = path.dirname(target);
  while (true) {
    try {
      const actual = await fs.realpath(cursor);
      if (!inside(root, actual)) {
        throw new Error("Download destination escapes through a symlink.");
      }
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

function permissionAction(action: string): string {
  switch (action) {
    case "check": return "Open / check SSH session";
    case "debug": return "Open / debug SSH session";
    case "exec": return "Open SSH access";
    case "upload": return "Open SSH access for file transfer";
    case "download": return "Open SSH access for file transfer";
    default: return action;
  }
}

export default tool({
  description:
    "Passwordless SSH to online Tailnet peers tagged tag:ssh. The first approved use grants a Topic-scoped authorization lease for the current server identity, username, and port, then opens a multiplexed SSH master. Each such scope also receives a separate server-side workspace; exec starts there and upload/download paths are relative to it, so multiple Topics can work on the same server concurrently without sharing a working directory. A dead or stuck master is transport state only: it is automatically recreated under the existing authorization lease without asking again. Permission is required again when the Tailnet identity, username/port, or Topic changes. Direct public-internet SSH and password authentication are intentionally unsupported.",
  args: {
    action: tool.schema.enum(["check", "debug", "exec", "upload", "download"]).describe("SSH operation."),
    target: tool.schema.string().describe("Tailnet hostname, MagicDNS name, or Tailscale IP of a visible tag:ssh peer."),
    user: tool.schema.string().describe("Remote OS username."),
    port: tool.schema.number().optional().describe("SSH port, default 22. Non-22 ports use managed-key SSH over Tailscale."),
    timeoutMs: tool.schema.number().optional().describe("Per-attempt timeout in ms, bounded to 3000-60000."),
    command: tool.schema.string().optional().describe("Remote command for exec. Never include credentials."),
    local_path: tool.schema.string().optional().describe("Worktree-relative local path for upload/download."),
    remote_path: tool.schema.string().optional().describe("Path relative to this Topic's isolated server-side SSH workspace. Absolute paths and traversal are rejected."),
    overwrite: tool.schema.boolean().optional().describe("Allow download to replace an existing worktree file."),
  },

  async execute(args, context) {
    const ssh = await service();
    const target = clean(args.target);
    const user = clean(args.user);
    if (!target || !user) throw new Error("SSH actions require target and user.");

    const port = args.port ?? 22;
    const scope = await ssh.resolveTailnetSshScope(context.sessionID);
    const common = {
      target,
      user,
      port,
      timeoutMs: args.timeoutMs,
      scope,
    };
    const description = await ssh.describeTailnetSshTarget(common);

    let localPath: string | undefined;
    let remotePath: string | undefined;
    let command: string | undefined;

    if (args.action === "exec") {
      command = args.command?.trim();
      if (!command) throw new Error("exec requires command.");
    }

    if (args.action === "upload" || args.action === "download") {
      const local = clean(args.local_path);
      remotePath = clean(args.remote_path);
      if (!local || !remotePath) {
        throw new Error(`${args.action} requires local_path and remote_path.`);
      }
      const worktree = path.resolve(context.directory || context.worktree || process.cwd());
      localPath = args.action === "upload"
        ? await uploadSource(worktree, local)
        : await downloadDestination(worktree, local, args.overwrite === true);
    }

    const permissionPattern =
      `server:${scope}:${description.identity}:${user}:${description.port}`;
    const activeConnection = await ssh.hasActiveTailnetSshConnection(common);
    let authorizationLease = await ssh.hasTailnetSshAuthorization(common);

    // A live master can only exist for this exact scoped connection key, so it
    // is safe to restore the in-process lease after a tool/module reload.
    if (activeConnection && !authorizationLease) {
      await ssh.grantTailnetSshAuthorization(common);
      authorizationLease = true;
    }

    if (!authorizationLease) {
      const topicScoped = scope.startsWith("topic:");
      await context.ask({
        permission: "ssh-remote",
        patterns: [permissionPattern],
        always: [],
        metadata: {
          input: {
            action: permissionAction(args.action),
            hostname: description.hostname,
            dnsName: description.dnsName ?? null,
            ip: description.ips[0] ?? null,
            os: description.os ?? "unknown",
            username: user,
            port: description.port,
            network: "Tailscale",
            authentication: description.authentication,
            password: "Not required",
            serverIdentity: description.identity.slice(0, 16),
            grantScope: topicScoped ? "This Telegram Topic" : "This OpenCode session",
            grantUntil: "This bot/OpenCode runtime, unless the Topic, server identity, username, or port changes",
            connectionMode: "Multiplexed SSH with automatic master recovery under the existing authorization lease",
            remoteWorkspace: description.remoteWorkspace ?? "Topic-scoped remote workspace",
            requestedAction: args.action,
            command: command ?? null,
            localPath: localPath ?? null,
            remotePath: remotePath ?? null,
          },
        },
      });
      await ssh.grantTailnetSshAuthorization(common);
      authorizationLease = true;
    }

    const authorized = {
      ...common,
      allowConnectionStart: authorizationLease,
    };
    if (args.action === "check") {
      return output(await ssh.checkTailnetSsh(authorized));
    }
    if (args.action === "debug") {
      return output(await ssh.debugTailnetSsh(authorized));
    }
    if (args.action === "exec") {
      return output(await ssh.execTailnetSsh({
        ...authorized,
        command: command!,
      }));
    }
    return output(await ssh.transferTailnetSshFile({
      ...authorized,
      localPath,
      remotePath,
      direction: args.action,
    }));
  },
});

import path from "node:path";
import { promises as fs } from "node:fs";
import {
  resolveSshTransport,
  sanitizeSshLog,
  validateSshTarget,
  type CommandResult,
  type CommandRunner,
  type SshCompatibility,
  type SshTargetInput,
} from "./ssh-service.js";
import { sshCredentialRunner } from "./ssh-auth-runner.js";

const SCP_BIN = process.env.SCP_REAL_BIN?.trim() || "/usr/bin/scp";
const TAILSCALE_BIN = process.env.TAILSCALE_BIN?.trim() || "/usr/local/bin/tailscale";
const FALLBACK_KEX = "ecdh-sha2-nistp256";

export interface SshTransferInput extends SshTargetInput {
  credentialId?: string;
  localPath: string;
  remotePath: string;
  direction: "upload" | "download";
}

function safeRemotePath(value: string): string {
  const remote = value.trim();
  if (!remote || remote.length > 4096 || remote.includes("\0") || /[\r\n]/u.test(remote) || remote.startsWith("-")) {
    throw new Error("remotePath is empty or unsafe.");
  }
  return remote;
}

function classify(result: CommandResult): string {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.timedOut) return "timeout";
  if (text.includes("permission denied")) return "authentication-denied";
  if (text.includes("no such file")) return "not-found";
  if (text.includes("connection refused")) return "connection-refused";
  if (text.includes("host key verification failed")) return "host-key-verification-failed";
  if (text.includes("no matching key exchange method")) return "kex-mismatch";
  return "transfer-failed";
}

function shouldFallback(result: CommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return result.timedOut || text.includes("no matching key exchange method") || text.includes("kex_exchange_identification");
}

function remoteSpec(host: string, user: string | undefined, remotePath: string): string {
  const target = user ? `${user}@${host}` : host;
  return `${target}:${remotePath}`;
}

function scpArgs(
  target: ReturnType<typeof validateSshTarget>,
  transport: "tailscale" | "direct",
  compatibility: SshCompatibility,
  localPath: string,
  remotePath: string,
  direction: "upload" | "download",
): string[] {
  const connectTimeoutSec = Math.max(3, Math.ceil(target.timeoutMs / 1000));
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${connectTimeoutSec}`,
    "-P", String(target.port),
  ];
  if (transport === "tailscale") args.push("-o", `ProxyCommand=${TAILSCALE_BIN} nc %h %p`);
  if (compatibility === "ecdh-nistp256") args.push("-o", `KexAlgorithms=${FALLBACK_KEX}`);
  const remote = remoteSpec(target.host, target.user, remotePath);
  args.push(direction === "upload" ? localPath : remote, direction === "upload" ? remote : localPath);
  return args;
}

export async function transferSshFile(
  input: SshTransferInput,
  baseRunner: CommandRunner,
): Promise<Record<string, unknown>> {
  const target = validateSshTarget(input);
  if (!target.user) throw new Error("transfer requires user.");
  const remotePath = safeRemotePath(input.remotePath);
  const localPath = path.resolve(input.localPath);
  const compatibility = input.compatibility ?? "auto";
  const resolved = await resolveSshTransport(input, baseRunner);
  const runner = sshCredentialRunner(input.credentialId, baseRunner);

  if (input.direction === "upload") {
    const stat = await fs.stat(localPath).catch(() => null);
    if (!stat?.isFile()) throw new Error("Upload source must be an existing regular file.");
  } else {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
  }

  const firstCompatibility: SshCompatibility = compatibility === "ecdh-nistp256" ? "ecdh-nistp256" : "default";
  const first = await runner({
    bin: SCP_BIN,
    args: scpArgs(target, resolved.transport, firstCompatibility, localPath, remotePath, input.direction),
    timeoutMs: target.timeoutMs,
  });
  if (first.ok) {
    const size = input.direction === "download" ? (await fs.stat(localPath).catch(() => null))?.size ?? null : (await fs.stat(localPath)).size;
    return {
      ok: true,
      direction: input.direction,
      transport: resolved.transport,
      compatibility: firstCompatibility,
      workingOverrides: firstCompatibility === "ecdh-nistp256" ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
      bytes: size,
      localPath,
      remotePath,
    };
  }

  if (resolved.transport === "tailscale" && compatibility === "auto" && shouldFallback(first)) {
    const fallback = await runner({
      bin: SCP_BIN,
      args: scpArgs(target, "tailscale", "ecdh-nistp256", localPath, remotePath, input.direction),
      timeoutMs: target.timeoutMs,
    });
    if (fallback.ok) {
      const size = input.direction === "download" ? (await fs.stat(localPath).catch(() => null))?.size ?? null : (await fs.stat(localPath)).size;
      return {
        ok: true,
        direction: input.direction,
        transport: "tailscale",
        compatibility: "ecdh-nistp256",
        diagnosis: "completed-with-kex-fallback",
        workingOverrides: [`KexAlgorithms=${FALLBACK_KEX}`],
        defaultAttempt: { ok: false, diagnosis: classify(first), timedOut: first.timedOut },
        bytes: size,
        localPath,
        remotePath,
      };
    }
    return {
      ok: false,
      direction: input.direction,
      transport: "tailscale",
      compatibility: "ecdh-nistp256",
      diagnosis: classify(fallback),
      defaultAttempt: { ok: false, diagnosis: classify(first), timedOut: first.timedOut },
      stderr: sanitizeSshLog(fallback.stderr),
    };
  }

  return {
    ok: false,
    direction: input.direction,
    transport: resolved.transport,
    compatibility: firstCompatibility,
    diagnosis: classify(first),
    stderr: sanitizeSshLog(first.stderr),
  };
}

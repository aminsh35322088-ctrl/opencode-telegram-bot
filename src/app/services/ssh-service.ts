import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  getTailscaleSocketPath,
  pingTailscaleSshDevice,
  resolveTailscaleSshDevice,
  type TailscaleSshDevice,
} from "./tailscale-integration-service.js";

const execFileAsync = promisify(execFile);
const SSH_BIN = process.env.SSH_REAL_BIN?.trim() || "/usr/bin/ssh";
const SCP_BIN = process.env.SCP_REAL_BIN?.trim() || "/usr/bin/scp";
const TAILSCALE_BIN = process.env.TAILSCALE_BIN?.trim() || "/usr/local/bin/tailscale";
const FALLBACK_KEX = "ecdh-sha2-nistp256";
const MAX_OUTPUT = 16_000;

export interface CommandRequest {
  bin: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}
export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
}
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

export interface TailnetSshTarget {
  target: string;
  user: string;
  timeoutMs?: number;
}
export interface TailnetSshExecInput extends TailnetSshTarget {
  command: string;
}
export interface TailnetSshTransferInput extends TailnetSshTarget {
  localPath: string;
  remotePath: string;
  direction: "upload" | "download";
}

export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(request.bin, request.args, {
      timeout: request.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: request.env ?? process.env,
      encoding: "utf8",
    });
    return { ok: true, stdout, stderr, timedOut: false, exitCode: 0, signal: null };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; killed?: boolean; signal?: string; code?: string | number; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? String(error),
      timedOut: Boolean(e.killed) || e.signal === "SIGTERM" || e.code === "ETIMEDOUT",
      exitCode: typeof e.code === "number" ? e.code : null,
      signal: e.signal ?? null,
    };
  }
}

function timeoutMs(value?: number): number {
  if (!Number.isFinite(value)) return 15_000;
  return Math.max(3_000, Math.min(Math.trunc(value ?? 15_000), 60_000));
}
function validateUser(value: string): string {
  const user = value.trim();
  if (!user || !/^[A-Za-z0-9._-]+$/u.test(user)) throw new Error("SSH user is required and must contain only safe username characters.");
  return user;
}
function validateRemotePath(value: string): string {
  const remote = value.trim();
  if (!remote || remote.length > 4096 || !/^[A-Za-z0-9_./~:@%+=,-]+$/u.test(remote) || remote.startsWith("-")) {
    throw new Error("remote_path contains unsupported or unsafe characters.");
  }
  return remote;
}
function clip(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `…(truncated, ${value.length} chars total)\n${value.slice(-MAX_OUTPUT)}`;
}
export function sanitizeSshLog(value: string): string {
  return clip(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .replace(/\b(password|passwd|token|secret|auth[-_]?key)\s*[=:]\s*\S+/giu, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
}
function classify(result: CommandResult): string {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.timedOut) return "timeout";
  if (text.includes("permission denied") || text.includes("access denied")) return "authentication-denied";
  if (text.includes("host key verification failed")) return "host-key-verification-failed";
  if (text.includes("connection refused")) return "connection-refused";
  if (text.includes("no route to host") || text.includes("network is unreachable")) return "network-unreachable";
  if (text.includes("no matching key exchange method")) return "kex-mismatch";
  return "ssh-failed";
}
function shouldFallback(result: CommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return result.timedOut || text.includes("no matching key exchange method") || text.includes("kex_exchange_identification");
}
function proxyCommand(): string {
  return `${TAILSCALE_BIN} --socket=${getTailscaleSocketPath()} nc %h %p`;
}
function sshArgs(device: TailscaleSshDevice, user: string, command: string, timeout: number, fallback: boolean, verbose = false): string[] {
  const args = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${Math.max(3, Math.ceil(timeout / 1000))}`,
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=1",
    "-o", `ProxyCommand=${proxyCommand()}`,
  ];
  if (fallback) args.push("-o", `KexAlgorithms=${FALLBACK_KEX}`);
  if (verbose) args.unshift("-vvv");
  args.push(`${user}@${device.name}`, command);
  return args;
}
async function sshAttempt(device: TailscaleSshDevice, user: string, command: string, timeout: number, runner: CommandRunner, fallback: boolean, verbose = false): Promise<CommandResult> {
  return runner({ bin: SSH_BIN, args: sshArgs(device, user, command, timeout, fallback, verbose), timeoutMs: timeout });
}
async function adaptiveSsh(device: TailscaleSshDevice, user: string, command: string, timeout: number, runner: CommandRunner, verbose = false): Promise<{ result: CommandResult; fallback: boolean; first?: CommandResult }> {
  const first = await sshAttempt(device, user, command, timeout, runner, false, verbose);
  if (first.ok || !shouldFallback(first)) return { result: first, fallback: false };
  const second = await sshAttempt(device, user, command, timeout, runner, true, verbose);
  return { result: second, fallback: true, first };
}

export async function checkTailnetSsh(input: TailnetSshTarget, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const user = validateUser(input.user);
  const timeout = timeoutMs(input.timeoutMs);
  const device = await resolveTailscaleSshDevice(input.target);
  const ping = await pingTailscaleSshDevice(device.name);
  if (!ping.ok) return { ok: false, device, tailnetReachable: false, diagnosis: "tailnet-unreachable", ping: ping.output };
  const attempt = await adaptiveSsh(device, user, "true", timeout, runner);
  return {
    ok: attempt.result.ok,
    device,
    user,
    tailnetReachable: true,
    diagnosis: attempt.result.ok ? (attempt.fallback ? "connected-with-kex-fallback" : "connected") : classify(attempt.result),
    compatibility: attempt.fallback ? "ecdh-nistp256" : "default",
    workingOverrides: attempt.result.ok && attempt.fallback ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
  };
}

export async function debugTailnetSsh(input: TailnetSshTarget, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const user = validateUser(input.user);
  const timeout = timeoutMs(input.timeoutMs);
  const device = await resolveTailscaleSshDevice(input.target);
  const ping = await pingTailscaleSshDevice(device.name);
  if (!ping.ok) return { ok: false, device, user, tailnetReachable: false, diagnosis: "tailnet-unreachable", ping: ping.output };
  const attempt = await adaptiveSsh(device, user, "true", timeout, runner, true);
  return {
    ok: attempt.result.ok,
    device,
    user,
    tailnetReachable: true,
    diagnosis: attempt.result.ok ? (attempt.fallback ? "kex-compatibility-required" : "connected") : classify(attempt.result),
    compatibility: attempt.fallback ? "ecdh-nistp256" : "default",
    workingOverrides: attempt.result.ok && attempt.fallback ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
    defaultAttempt: attempt.first ? { ok: attempt.first.ok, diagnosis: classify(attempt.first), timedOut: attempt.first.timedOut } : undefined,
    log: sanitizeSshLog([attempt.result.stdout, attempt.result.stderr].filter(Boolean).join("\n")),
  };
}

export async function execTailnetSsh(input: TailnetSshExecInput, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const user = validateUser(input.user);
  const command = input.command.trim();
  if (!command || command.length > 8_000 || command.includes("\0")) throw new Error("SSH command is empty or invalid.");
  const timeout = timeoutMs(input.timeoutMs);
  const device = await resolveTailscaleSshDevice(input.target);
  const attempt = await adaptiveSsh(device, user, command, timeout, runner);
  return {
    ok: attempt.result.ok,
    device,
    user,
    diagnosis: attempt.result.ok ? (attempt.fallback ? "completed-with-kex-fallback" : "completed") : classify(attempt.result),
    compatibility: attempt.fallback ? "ecdh-nistp256" : "default",
    workingOverrides: attempt.result.ok && attempt.fallback ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
    stdout: sanitizeSshLog(attempt.result.stdout),
    stderr: sanitizeSshLog(attempt.result.stderr),
    exitCode: attempt.result.exitCode,
  };
}

function scpArgs(device: TailscaleSshDevice, user: string, localPath: string, remotePath: string, direction: "upload" | "download", timeout: number, fallback: boolean): string[] {
  const args = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${Math.max(3, Math.ceil(timeout / 1000))}`,
    "-o", `ProxyCommand=${proxyCommand()}`,
  ];
  if (fallback) args.push("-o", `KexAlgorithms=${FALLBACK_KEX}`);
  const remote = `${user}@${device.name}:${remotePath}`;
  args.push(direction === "upload" ? localPath : remote, direction === "upload" ? remote : localPath);
  return args;
}

export async function transferTailnetSshFile(input: TailnetSshTransferInput, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const user = validateUser(input.user);
  const timeout = timeoutMs(input.timeoutMs);
  const device = await resolveTailscaleSshDevice(input.target);
  const remotePath = validateRemotePath(input.remotePath);
  const localPath = path.resolve(input.localPath);
  if (input.direction === "upload") {
    const stat = await fs.stat(localPath).catch(() => null);
    if (!stat?.isFile()) throw new Error("Upload source must be an existing regular file.");
  } else {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
  }
  const first = await runner({ bin: SCP_BIN, args: scpArgs(device, user, localPath, remotePath, input.direction, timeout, false), timeoutMs: timeout });
  let result = first;
  let fallback = false;
  if (!first.ok && shouldFallback(first)) {
    result = await runner({ bin: SCP_BIN, args: scpArgs(device, user, localPath, remotePath, input.direction, timeout, true), timeoutMs: timeout });
    fallback = true;
  }
  const bytes = result.ok ? (await fs.stat(localPath).catch(() => null))?.size ?? null : null;
  return {
    ok: result.ok,
    device,
    user,
    direction: input.direction,
    diagnosis: result.ok ? (fallback ? "completed-with-kex-fallback" : "completed") : classify(result),
    compatibility: fallback ? "ecdh-nistp256" : "default",
    workingOverrides: result.ok && fallback ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
    bytes,
    localPath,
    remotePath,
    stderr: result.ok ? "" : sanitizeSshLog(result.stderr),
  };
}

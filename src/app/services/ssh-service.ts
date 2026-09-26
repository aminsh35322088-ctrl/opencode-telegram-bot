import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  getTailscaleSocketPath,
  pingTailscaleSshDevice,
  resolveTailscaleSshDevice,
  type TailscaleSshDevice,
} from "./tailscale-integration-service.js";
import {
  getManagedSshKnownHostsPath,
  getManagedSshPrivateKeyPath,
} from "./ssh-key-service.js";

const execFileAsync = promisify(execFile);
const SSH_BIN = process.env.SSH_REAL_BIN?.trim() || "/usr/bin/ssh";
const SCP_BIN = process.env.SCP_REAL_BIN?.trim() || "/usr/bin/scp";
const TAILSCALE_BIN = process.env.TAILSCALE_BIN?.trim() || "/usr/local/bin/tailscale";
const FALLBACK_KEX = "ecdh-sha2-nistp256";
const MAX_OUTPUT = 16_000;
const DEFAULT_PORT = 22;

export type SshAuthMode = "tailscale-ssh" | "managed-key";
export interface CommandRequest { bin: string; args: string[]; timeoutMs: number; env?: NodeJS.ProcessEnv; }
export interface CommandResult { ok: boolean; stdout: string; stderr: string; timedOut: boolean; exitCode: number | null; signal: string | null; }
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;
export interface TailnetSshTarget { target: string; user: string; port?: number; timeoutMs?: number; }
export interface TailnetSshExecInput extends TailnetSshTarget { command: string; }
export interface TailnetSshTransferInput extends TailnetSshTarget { localPath: string; remotePath: string; direction: "upload" | "download"; }
export interface TailnetSshTargetDescription {
  hostname: string; dnsName?: string; ips: string[]; os?: string; username: string; port: number;
  network: "Tailscale"; authMode: SshAuthMode; authentication: string; passwordRequired: false; nativeTailscaleSsh: boolean;
}

export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(request.bin, request.args, {
      timeout: request.timeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: request.env ?? process.env, encoding: "utf8",
    });
    return { ok: true, stdout, stderr, timedOut: false, exitCode: 0, signal: null };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; killed?: boolean; signal?: string; code?: string | number; message?: string };
    return {
      ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(error),
      timedOut: Boolean(e.killed) || e.signal === "SIGTERM" || e.code === "ETIMEDOUT",
      exitCode: typeof e.code === "number" ? e.code : null, signal: e.signal ?? null,
    };
  }
}
function boundedTimeout(value?: number): number {
  if (!Number.isFinite(value)) return 15_000;
  return Math.max(3_000, Math.min(Math.trunc(value ?? 15_000), 60_000));
}
function validatePort(value?: number): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Math.trunc(value);
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error("SSH port must be between 1 and 65535.");
  return port;
}
function validateUser(value: string): string {
  const user = value.trim();
  if (!user || !/^[A-Za-z0-9._-]+$/u.test(user)) throw new Error("SSH user is required and must contain only safe username characters.");
  return user;
}
function validateRemotePath(value: string): string {
  const remote = value.trim();
  if (!remote || remote.length > 4096 || remote.startsWith("-") || !/^[A-Za-z0-9_./~:@%+=,\\-]+$/u.test(remote)) {
    throw new Error("remote_path is empty or unsafe.");
  }
  return remote;
}
function clip(value: string): string { return value.length <= MAX_OUTPUT ? value : `…(truncated, ${value.length} chars total)\n${value.slice(-MAX_OUTPUT)}`; }
export function sanitizeSshLog(value: string): string {
  return clip(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .replace(/\b(password|passwd|token|secret|auth[-_]?key)\s*[=:]\s*\S+/giu, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
}
function classify(result: CommandResult, authMode: SshAuthMode): string {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.timedOut || output.includes("port 65535 timed out")) return "transport-timeout";
  if (output.includes("no matching key exchange method")) return "kex-mismatch";
  if (output.includes("kex_exchange_identification")) return "kex-handshake-failed";
  if (output.includes("host key verification failed")) return "host-key-verification-failed";
  if (output.includes("connection refused")) return "connection-refused";
  if (output.includes("no route to host") || output.includes("network is unreachable")) return "network-unreachable";
  if (output.includes("permission denied") || output.includes("access denied") || output.includes("unable to authenticate")) {
    return authMode === "managed-key" ? "managed-key-not-authorized" : "tailscale-ssh-policy-denied";
  }
  if (output.includes("could not resolve hostname") || output.includes("name or service not known")) return "hostname-resolution-failed";
  return "ssh-failed";
}
function shouldNativeKexFallback(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return result.timedOut || output.includes("port 65535 timed out") || output.includes("no matching key exchange method") || output.includes("kex_exchange_identification");
}
function proxyCommand(): string { return `${TAILSCALE_BIN} --socket=${getTailscaleSocketPath()} nc %h %p`; }
function preferredHost(device: TailscaleSshDevice): string {
  return device.ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/u.test(ip)) ?? device.ips[0] ?? device.dnsName ?? device.name;
}
function authModeFor(device: TailscaleSshDevice, port: number): SshAuthMode {
  return port === DEFAULT_PORT && device.nativeTailscaleSsh ? "tailscale-ssh" : "managed-key";
}
function authLabel(authMode: SshAuthMode): string {
  return authMode === "tailscale-ssh" ? "Tailscale SSH (Tailnet identity)" : "Managed Ed25519 SSH key over Tailscale";
}

export async function describeTailnetSshTarget(input: TailnetSshTarget): Promise<TailnetSshTargetDescription> {
  const user = validateUser(input.user);
  const port = validatePort(input.port);
  const device = await resolveTailscaleSshDevice(input.target);
  const authMode = authModeFor(device, port);
  return {
    hostname: device.name, ...(device.dnsName ? { dnsName: device.dnsName } : {}),
    ips: device.ips, ...(device.os ? { os: device.os } : {}),
    username: user, port, network: "Tailscale", authMode,
    authentication: authLabel(authMode), passwordRequired: false,
    nativeTailscaleSsh: authMode === "tailscale-ssh",
  };
}

async function withKexShim<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-ts-ssh-"));
  const shim = path.join(directory, "ssh");
  try {
    await fs.writeFile(shim, `#!/bin/sh\nexec "${SSH_BIN.replaceAll('"', '\\"')}" -o KexAlgorithms=${FALLBACK_KEX} "$@"\n`, { mode: 0o700 });
    return await fn({ ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}` });
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
async function nativeAttempt(
  device: TailscaleSshDevice, user: string, command: string, timeout: number,
  runner: CommandRunner, fallback: boolean, verbose: boolean,
): Promise<CommandResult> {
  const args = [`--socket=${getTailscaleSocketPath()}`, "ssh", `${user}@${device.name}`, command];
  const debugEnv = verbose ? { TS_DEBUG_SSH_EXEC: "1" } : {};
  if (!fallback) return runner({ bin: TAILSCALE_BIN, args, timeoutMs: timeout, env: { ...process.env, ...debugEnv } });
  return withKexShim((shimEnv) => runner({ bin: TAILSCALE_BIN, args, timeoutMs: timeout, env: { ...shimEnv, ...debugEnv } }));
}
async function adaptiveNativeSsh(
  device: TailscaleSshDevice, user: string, command: string, timeout: number,
  runner: CommandRunner, verbose = false,
): Promise<{ result: CommandResult; fallback: boolean; first?: CommandResult }> {
  const first = await nativeAttempt(device, user, command, timeout, runner, false, verbose);
  if (first.ok || !shouldNativeKexFallback(first)) return { result: first, fallback: false };
  const second = await nativeAttempt(device, user, command, timeout, runner, true, verbose);
  return { result: second, fallback: true, first };
}
async function managedKeySsh(
  device: TailscaleSshDevice, user: string, port: number, command: string,
  timeout: number, runner: CommandRunner, verbose = false,
): Promise<CommandResult> {
  const privateKey = await getManagedSshPrivateKeyPath();
  const knownHosts = await getManagedSshKnownHostsPath();
  const args = [
    ...(verbose ? ["-vvv"] : []),
    "-o", `ProxyCommand=${proxyCommand()}`,
    "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no", "-o", "PreferredAuthentications=publickey",
    "-o", "IdentitiesOnly=yes", "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${Math.max(3, Math.ceil(timeout / 1000))}`,
    "-i", privateKey, "-p", String(port), `${user}@${preferredHost(device)}`, command,
  ];
  return runner({ bin: SSH_BIN, args, timeoutMs: timeout });
}
async function runSsh(
  device: TailscaleSshDevice, user: string, port: number, command: string,
  timeout: number, runner: CommandRunner, verbose = false,
): Promise<{ result: CommandResult; authMode: SshAuthMode; fallback: boolean; first?: CommandResult }> {
  const authMode = authModeFor(device, port);
  if (authMode === "tailscale-ssh") {
    const attempt = await adaptiveNativeSsh(device, user, command, timeout, runner, verbose);
    return { ...attempt, authMode };
  }
  return { result: await managedKeySsh(device, user, port, command, timeout, runner, verbose), authMode, fallback: false };
}

export async function checkTailnetSsh(input: TailnetSshTarget, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const user = validateUser(input.user), port = validatePort(input.port), timeout = boundedTimeout(input.timeoutMs);
  const device = await resolveTailscaleSshDevice(input.target);
  const ping = await pingTailscaleSshDevice(device.name);
  if (!ping.ok) return { ok: false, device, user, port, tailnetReachable: false, diagnosis: "tailnet-unreachable", ping: ping.output };
  const attempt = await runSsh(device, user, port, "exit 0", timeout, runner);
  return {
    ok: attempt.result.ok, device, user, port, tailnetReachable: true,
    authMode: attempt.authMode, authentication: authLabel(attempt.authMode), passwordRequired: false,
    diagnosis: attempt.result.ok ? (attempt.fallback ? "connected-with-kex-fallback" : "connected") : classify(attempt.result, attempt.authMode),
    compatibility: attempt.fallback ? "ecdh-nistp256" : "default",
    workingOverrides: attempt.result.ok && attempt.fallback ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
  };
}
export async function debugTailnetSsh(input: TailnetSshTarget, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const user = validateUser(input.user), port = validatePort(input.port), timeout = boundedTimeout(input.timeoutMs);
  const device = await resolveTailscaleSshDevice(input.target);
  const ping = await pingTailscaleSshDevice(device.name);
  if (!ping.ok) return { ok: false, device, user, port, tailnetReachable: false, diagnosis: "tailnet-unreachable", ping: ping.output };
  const attempt = await runSsh(device, user, port, "exit 0", timeout, runner, true);
  return {
    ok: attempt.result.ok, device, user, port, tailnetReachable: true,
    authMode: attempt.authMode, authentication: authLabel(attempt.authMode), passwordRequired: false,
    diagnosis: attempt.result.ok ? (attempt.fallback ? "kex-compatibility-required" : "connected") : classify(attempt.result, attempt.authMode),
    compatibility: attempt.fallback ? "ecdh-nistp256" : "default",
    workingOverrides: attempt.result.ok && attempt.fallback ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
    defaultAttempt: attempt.first ? { ok: attempt.first.ok, diagnosis: classify(attempt.first, attempt.authMode), timedOut: attempt.first.timedOut } : undefined,
    log: sanitizeSshLog([attempt.result.stdout, attempt.result.stderr].filter(Boolean).join("\n")),
  };
}
export async function execTailnetSsh(input: TailnetSshExecInput, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const user = validateUser(input.user), port = validatePort(input.port);
  const command = input.command.trim();
  if (!command || command.length > 8_000 || command.includes("\0")) throw new Error("SSH command is empty or invalid.");
  const timeout = boundedTimeout(input.timeoutMs);
  const device = await resolveTailscaleSshDevice(input.target);
  const attempt = await runSsh(device, user, port, command, timeout, runner);
  return {
    ok: attempt.result.ok, device, user, port,
    authMode: attempt.authMode, authentication: authLabel(attempt.authMode), passwordRequired: false,
    diagnosis: attempt.result.ok ? (attempt.fallback ? "completed-with-kex-fallback" : "completed") : classify(attempt.result, attempt.authMode),
    compatibility: attempt.fallback ? "ecdh-nistp256" : "default",
    workingOverrides: attempt.result.ok && attempt.fallback ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
    stdout: sanitizeSshLog(attempt.result.stdout), stderr: sanitizeSshLog(attempt.result.stderr), exitCode: attempt.result.exitCode,
  };
}

function tailscaleKnownHostsPath(): string {
  const configRoot = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configRoot, "tailscale", "ssh_known_hosts");
}
async function scpArgs(
  device: TailscaleSshDevice, user: string, port: number, localPath: string, remotePath: string,
  direction: "upload" | "download", timeout: number, authMode: SshAuthMode, fallback: boolean,
): Promise<string[]> {
  const args = ["-o", `ProxyCommand=${proxyCommand()}`, "-o", `ConnectTimeout=${Math.max(3, Math.ceil(timeout / 1000))}`];
  if (authMode === "tailscale-ssh") {
    args.push("-o", `UserKnownHostsFile=${tailscaleKnownHostsPath()}`, "-o", "UpdateHostKeys=no",
      "-o", "StrictHostKeyChecking=yes", "-o", "CanonicalizeHostname=no");
    if (fallback) args.push("-o", `KexAlgorithms=${FALLBACK_KEX}`);
  } else {
    const privateKey = await getManagedSshPrivateKeyPath(), knownHosts = await getManagedSshKnownHostsPath();
    args.push("-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
      "-o", "PreferredAuthentications=publickey", "-o", "IdentitiesOnly=yes",
      "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=accept-new", "-i", privateKey);
  }
  args.push("-P", String(port));
  const remote = `${user}@${preferredHost(device)}:${remotePath}`;
  args.push(direction === "upload" ? localPath : remote, direction === "upload" ? remote : localPath);
  return args;
}
export async function transferTailnetSshFile(input: TailnetSshTransferInput, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const user = validateUser(input.user), port = validatePort(input.port), timeout = boundedTimeout(input.timeoutMs);
  const device = await resolveTailscaleSshDevice(input.target);
  const remotePath = validateRemotePath(input.remotePath), localPath = path.resolve(input.localPath);
  if (input.direction === "upload") {
    const stat = await fs.stat(localPath).catch(() => null);
    if (!stat?.isFile()) throw new Error("Upload source must be an existing regular file.");
  } else await fs.mkdir(path.dirname(localPath), { recursive: true });
  const authMode = authModeFor(device, port);
  let fallback = false;
  if (authMode === "tailscale-ssh") {
    const preflight = await adaptiveNativeSsh(device, user, "exit 0", timeout, runner);
    if (!preflight.result.ok) return {
      ok: false, device, user, port, direction: input.direction, authMode,
      authentication: authLabel(authMode), passwordRequired: false,
      diagnosis: classify(preflight.result, authMode), stderr: sanitizeSshLog(preflight.result.stderr),
    };
    fallback = preflight.fallback;
  }
  const result = await runner({
    bin: SCP_BIN,
    args: await scpArgs(device, user, port, localPath, remotePath, input.direction, timeout, authMode, fallback),
    timeoutMs: timeout,
  });
  const bytes = result.ok ? (await fs.stat(localPath).catch(() => null))?.size ?? null : null;
  return {
    ok: result.ok, device, user, port, direction: input.direction, authMode,
    authentication: authLabel(authMode), passwordRequired: false,
    diagnosis: result.ok ? (fallback ? "completed-with-kex-fallback" : "completed") : classify(result, authMode),
    compatibility: fallback ? "ecdh-nistp256" : "default",
    workingOverrides: result.ok && fallback ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
    bytes, localPath, remotePath, stderr: result.ok ? "" : sanitizeSshLog(result.stderr),
  };
}

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 16_000;
const TAILSCALE_BIN = process.env.TAILSCALE_BIN?.trim() || "/usr/local/bin/tailscale";
const REAL_SSH_BIN = process.env.SSH_REAL_BIN?.trim() || "/usr/bin/ssh";
const FALLBACK_KEX = "ecdh-sha2-nistp256";

export type SshTransport = "auto" | "tailscale" | "direct";
export type SshCompatibility = "auto" | "default" | "ecdh-nistp256";
export type SshDebugDepth = "basic" | "handshake" | "full";

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

export interface SshTargetInput {
  host: string;
  user?: string;
  port?: number;
  transport?: SshTransport;
  compatibility?: SshCompatibility;
  timeoutMs?: number;
}

export interface SshExecInput extends SshTargetInput {
  command: string;
}

export interface SshDebugInput extends SshTargetInput {
  depth?: SshDebugDepth;
}

interface TailnetPeer {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  Tags?: string[];
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
    const e = error as {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
      code?: string | number;
      message?: string;
    };
    const timedOut = Boolean(e.killed) || e.signal === "SIGTERM" || e.code === "ETIMEDOUT";
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? String(error),
      timedOut,
      exitCode: typeof e.code === "number" ? e.code : null,
      signal: e.signal ?? null,
    };
  }
}

function clampTimeout(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(3_000, Math.min(Math.trunc(value ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS));
}

function normalizeHost(value: string): string {
  return value.trim().replace(/\.$/u, "").toLowerCase();
}

export function validateSshTarget(input: SshTargetInput): { host: string; user?: string; port: number; timeoutMs: number } {
  const host = input.host.trim();
  if (!host) throw new Error("host is required.");
  if (host.startsWith("-") || /[\s\0\r\n]/u.test(host) || !/^[A-Za-z0-9._:[\]-]+$/u.test(host)) {
    throw new Error("host must be a hostname or IP address without whitespace or shell syntax.");
  }
  const user = input.user?.trim();
  if (user && !/^[A-Za-z0-9._-]+$/u.test(user)) throw new Error("user contains unsupported characters.");
  const port = Math.trunc(input.port ?? 22);
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error("port must be between 1 and 65535.");
  return { host, ...(user ? { user } : {}), port, timeoutMs: clampTimeout(input.timeoutMs) };
}

function clip(value: string): string {
  if (value.length <= MAX_OUTPUT) return value;
  return `…(truncated, ${value.length} chars total)\n${value.slice(-MAX_OUTPUT)}`;
}

export function sanitizeSshLog(value: string): string {
  return clip(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .replace(/\b(password|passwd|token|secret|auth[-_]?key)\s*[=:]\s*\S+/giu, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
}

function peerMatches(peer: TailnetPeer, host: string): boolean {
  const wanted = normalizeHost(host);
  const names = [peer.HostName, peer.DNSName]
    .filter((value): value is string => Boolean(value))
    .map(normalizeHost);
  if (names.includes(wanted)) return true;
  if (names.some((name) => name.split(".")[0] === wanted)) return true;
  return (peer.TailscaleIPs ?? []).some((ip) => normalizeHost(ip) === wanted);
}

async function tailnetPeer(host: string, runner: CommandRunner): Promise<TailnetPeer | null> {
  const status = await runner({ bin: TAILSCALE_BIN, args: ["status", "--json"], timeoutMs: 5_000 });
  if (!status.ok) return null;
  try {
    const parsed = JSON.parse(status.stdout) as { Self?: TailnetPeer; Peer?: Record<string, TailnetPeer> };
    const peers = [parsed.Self, ...Object.values(parsed.Peer ?? {})].filter((peer): peer is TailnetPeer => Boolean(peer));
    return peers.find((peer) => peerMatches(peer, host)) ?? null;
  } catch {
    return null;
  }
}

export async function resolveSshTransport(
  input: SshTargetInput,
  runner: CommandRunner = runCommand,
): Promise<{ transport: Exclude<SshTransport, "auto">; peer: TailnetPeer | null }> {
  const requested = input.transport ?? "auto";
  if (requested === "direct") return { transport: "direct", peer: null };
  const peer = await tailnetPeer(input.host, runner);
  if (requested === "tailscale") return { transport: "tailscale", peer };
  return peer ? { transport: "tailscale", peer } : { transport: "direct", peer: null };
}

function sshTarget(host: string, user?: string): string {
  return user ? `${user}@${host}` : host;
}

function directArgs(target: { host: string; user?: string; port: number; timeoutMs: number }, command: string, compatibility: SshCompatibility): string[] {
  const connectTimeoutSec = Math.max(3, Math.ceil(target.timeoutMs / 1000));
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${connectTimeoutSec}`,
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=1",
    "-p", String(target.port),
  ];
  if (compatibility === "ecdh-nistp256") args.push("-o", `KexAlgorithms=${FALLBACK_KEX}`);
  args.push(sshTarget(target.host, target.user), command);
  return args;
}

async function withSshShim<T>(options: string[], callback: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-ssh-"));
  const shim = path.join(directory, "ssh");
  const fixed = options.map((option) => `'${option.replaceAll("'", "'\\''")}'`).join(" ");
  await fs.writeFile(shim, `#!/bin/sh\nexec ${REAL_SSH_BIN} ${fixed} "$@"\n`, { mode: 0o700 });
  try {
    return await callback({ ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, SSH_ASKPASS_REQUIRE: "never" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function tailscaleSsh(
  target: { host: string; user?: string; port: number; timeoutMs: number },
  command: string,
  runner: CommandRunner,
  compatibility: SshCompatibility,
  verbose = false,
): Promise<CommandResult> {
  if (target.port !== 22) {
    const proxy = `${TAILSCALE_BIN} nc %h %p`;
    const args = directArgs(target, command, compatibility);
    args.splice(0, 0, "-o", `ProxyCommand=${proxy}`);
    if (verbose) args.unshift("-vvv");
    return runner({ bin: REAL_SSH_BIN, args, timeoutMs: target.timeoutMs });
  }

  const args = ["ssh", sshTarget(target.host, target.user), command];
  const shimOptions: string[] = [];
  if (verbose) shimOptions.push("-vvv");
  if (compatibility === "ecdh-nistp256") shimOptions.push("-o", `KexAlgorithms=${FALLBACK_KEX}`);
  if (!shimOptions.length) return runner({ bin: TAILSCALE_BIN, args, timeoutMs: target.timeoutMs });
  return withSshShim(shimOptions, (env) => runner({ bin: TAILSCALE_BIN, args, timeoutMs: target.timeoutMs, env }));
}

function shouldTryFallback(result: CommandResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return result.timedOut || combined.includes("no matching key exchange method") || combined.includes("kex_exchange_identification");
}

function resultLog(result: CommandResult): string {
  return sanitizeSshLog([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
}

function classifyFailure(result: CommandResult): string {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.timedOut) return "timeout";
  if (text.includes("permission denied") || text.includes("access denied")) return "authentication-denied";
  if (text.includes("host key verification failed")) return "host-key-verification-failed";
  if (text.includes("connection refused")) return "connection-refused";
  if (text.includes("no route to host") || text.includes("network is unreachable")) return "network-unreachable";
  if (text.includes("could not resolve") || text.includes("name or service not known")) return "name-resolution-failed";
  return "ssh-failed";
}

export async function checkSshTarget(input: SshTargetInput, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const target = validateSshTarget(input);
  const resolved = await resolveSshTransport(input, runner);

  if (resolved.transport === "tailscale") {
    const ping = await runner({ bin: TAILSCALE_BIN, args: ["ping", target.host], timeoutMs: Math.min(target.timeoutMs, 8_000) });
    const banner = await runner({ bin: TAILSCALE_BIN, args: ["nc", target.host, String(target.port)], timeoutMs: 3_000 });
    const bannerText = `${banner.stdout}\n${banner.stderr}`;
    return {
      ok: ping.ok && /SSH-2\.0-/u.test(bannerText),
      transport: "tailscale",
      host: target.host,
      port: target.port,
      peer: resolved.peer ? {
        hostName: resolved.peer.HostName,
        dnsName: resolved.peer.DNSName,
        ips: resolved.peer.TailscaleIPs ?? [],
        online: resolved.peer.Online ?? null,
        tags: resolved.peer.Tags ?? [],
      } : null,
      tailnetReachable: ping.ok,
      sshBanner: bannerText.match(/SSH-2\.0-[^\r\n]*/u)?.[0] ?? null,
      ping: sanitizeSshLog(ping.stdout || ping.stderr),
    };
  }

  const probe = await runner({
    bin: REAL_SSH_BIN,
    args: directArgs(target, "true", "default"),
    timeoutMs: target.timeoutMs,
  });
  return {
    ok: probe.ok,
    transport: "direct",
    host: target.host,
    port: target.port,
    diagnosis: probe.ok ? "connected" : classifyFailure(probe),
    output: resultLog(probe),
  };
}

export async function debugSshTarget(input: SshDebugInput, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const target = validateSshTarget(input);
  if (!target.user) throw new Error("debug requires user.");
  const resolved = await resolveSshTransport(input, runner);
  const depth = input.depth ?? "handshake";
  const compatibility = input.compatibility ?? "auto";

  if (resolved.transport === "direct") {
    const chosen = compatibility === "ecdh-nistp256" ? compatibility : "default";
    const probe = await runner({
      bin: REAL_SSH_BIN,
      args: ["-vvv", ...directArgs(target, "true", chosen)],
      timeoutMs: target.timeoutMs,
    });
    return {
      ok: probe.ok,
      transport: "direct",
      compatibility: chosen,
      diagnosis: probe.ok ? "connected" : classifyFailure(probe),
      log: depth === "basic" ? undefined : resultLog(probe),
    };
  }

  const ping = await runner({ bin: TAILSCALE_BIN, args: ["ping", target.host], timeoutMs: Math.min(target.timeoutMs, 8_000) });
  const banner = await runner({ bin: TAILSCALE_BIN, args: ["nc", target.host, String(target.port)], timeoutMs: 3_000 });
  const bannerText = `${banner.stdout}\n${banner.stderr}`;
  const base = {
    transport: "tailscale" as const,
    host: target.host,
    user: target.user,
    port: target.port,
    peer: resolved.peer ? {
      hostName: resolved.peer.HostName,
      dnsName: resolved.peer.DNSName,
      ips: resolved.peer.TailscaleIPs ?? [],
      online: resolved.peer.Online ?? null,
      tags: resolved.peer.Tags ?? [],
    } : null,
    tailnetReachable: ping.ok,
    sshBanner: bannerText.match(/SSH-2\.0-[^\r\n]*/u)?.[0] ?? null,
  };

  if (depth === "basic") return { ...base, ok: ping.ok && /SSH-2\.0-/u.test(bannerText) };

  const firstCompatibility = compatibility === "ecdh-nistp256" ? "ecdh-nistp256" : "default";
  const first = await tailscaleSsh(target, "true", runner, firstCompatibility, true);
  if (first.ok) {
    return {
      ...base,
      ok: true,
      diagnosis: "connected",
      compatibility: firstCompatibility,
      workingOverrides: firstCompatibility === "ecdh-nistp256" ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
      log: depth === "full" ? resultLog(first) : undefined,
    };
  }

  if (compatibility !== "default" && firstCompatibility === "default" && shouldTryFallback(first)) {
    const fallback = await tailscaleSsh(target, "true", runner, "ecdh-nistp256", true);
    if (fallback.ok) {
      return {
        ...base,
        ok: true,
        diagnosis: "kex-compatibility-required",
        compatibility: "ecdh-nistp256",
        workingOverrides: [`KexAlgorithms=${FALLBACK_KEX}`],
        defaultAttempt: { ok: false, diagnosis: classifyFailure(first), timedOut: first.timedOut },
        log: depth === "full" ? resultLog(fallback) : undefined,
      };
    }
    return {
      ...base,
      ok: false,
      diagnosis: classifyFailure(fallback),
      compatibility: "ecdh-nistp256",
      workingOverrides: [],
      defaultAttempt: { ok: false, diagnosis: classifyFailure(first), timedOut: first.timedOut },
      fallbackAttempt: { ok: false, diagnosis: classifyFailure(fallback), timedOut: fallback.timedOut },
      log: depth === "full" ? resultLog(fallback) : undefined,
    };
  }

  return {
    ...base,
    ok: false,
    diagnosis: classifyFailure(first),
    compatibility: firstCompatibility,
    workingOverrides: [],
    log: depth === "full" ? resultLog(first) : undefined,
  };
}

export async function execSshCommand(input: SshExecInput, runner: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  const target = validateSshTarget(input);
  if (!target.user) throw new Error("exec requires user.");
  const command = input.command.trim();
  if (!command) throw new Error("exec requires a non-empty command.");
  if (command.length > 8_000 || command.includes("\0")) throw new Error("command is too large or contains invalid bytes.");

  const resolved = await resolveSshTransport(input, runner);
  const compatibility = input.compatibility ?? "auto";

  if (resolved.transport === "direct") {
    const chosen = compatibility === "ecdh-nistp256" ? compatibility : "default";
    const executed = await runner({
      bin: REAL_SSH_BIN,
      args: directArgs(target, command, chosen),
      timeoutMs: target.timeoutMs,
    });
    return {
      ok: executed.ok,
      transport: "direct",
      compatibility: chosen,
      diagnosis: executed.ok ? "completed" : classifyFailure(executed),
      stdout: sanitizeSshLog(executed.stdout),
      stderr: sanitizeSshLog(executed.stderr),
      exitCode: executed.exitCode,
    };
  }

  const firstCompatibility = compatibility === "ecdh-nistp256" ? "ecdh-nistp256" : "default";
  const first = await tailscaleSsh(target, command, runner, firstCompatibility, false);
  if (first.ok) {
    return {
      ok: true,
      transport: "tailscale",
      compatibility: firstCompatibility,
      workingOverrides: firstCompatibility === "ecdh-nistp256" ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
      stdout: sanitizeSshLog(first.stdout),
      stderr: sanitizeSshLog(first.stderr),
      exitCode: first.exitCode,
    };
  }

  if (compatibility === "auto" && firstCompatibility === "default" && shouldTryFallback(first)) {
    const fallback = await tailscaleSsh(target, command, runner, "ecdh-nistp256", false);
    return {
      ok: fallback.ok,
      transport: "tailscale",
      compatibility: "ecdh-nistp256",
      diagnosis: fallback.ok ? "completed-with-kex-fallback" : classifyFailure(fallback),
      workingOverrides: fallback.ok ? [`KexAlgorithms=${FALLBACK_KEX}`] : [],
      defaultAttempt: { ok: false, diagnosis: classifyFailure(first), timedOut: first.timedOut },
      stdout: sanitizeSshLog(fallback.stdout),
      stderr: sanitizeSshLog(fallback.stderr),
      exitCode: fallback.exitCode,
    };
  }

  return {
    ok: false,
    transport: "tailscale",
    compatibility: firstCompatibility,
    diagnosis: classifyFailure(first),
    workingOverrides: [],
    stdout: sanitizeSshLog(first.stdout),
    stderr: sanitizeSshLog(first.stderr),
    exitCode: first.exitCode,
  };
}

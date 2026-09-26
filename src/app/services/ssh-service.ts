import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import { findTelegramTopicBindingBySessionId } from "./telegram-topic-store.js";

const execFileAsync = promisify(execFile);
const SSH_BIN = process.env.SSH_REAL_BIN?.trim() || "/usr/bin/ssh";
const SCP_BIN = process.env.SCP_REAL_BIN?.trim() || "/usr/bin/scp";
const TAILSCALE_BIN = process.env.TAILSCALE_BIN?.trim() || "/usr/local/bin/tailscale";
const MAX_OUTPUT = 16_000;
const DEFAULT_PORT = 22;
const CONTROL_DIR = process.env.SSH_CONTROL_DIR?.trim() || path.join(os.tmpdir(), "opencode-ssh-control");
const HOSTKEY_DIR = process.env.SSH_HOSTKEY_DIR?.trim() || path.join(os.tmpdir(), "opencode-ssh-hostkeys");
const NATIVE_KEX_ORDER = "ecdh-sha2-nistp256,curve25519-sha256";
const REMOTE_WORKSPACE_ROOT = ".opencode-telegram/ssh-workspaces";
const masterLocks = new Map<string, Promise<CommandResult>>();
const authorizationLeases = new Set<string>();

export type SshAuthMode = "tailscale-ssh" | "managed-key";

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
  port?: number;
  timeoutMs?: number;
  scope?: string;
  allowConnectionStart?: boolean;
}

export interface TailnetSshExecInput extends TailnetSshTarget {
  command: string;
}

export interface TailnetSshTransferInput extends TailnetSshTarget {
  localPath: string;
  remotePath: string;
  direction: "upload" | "download";
}

export interface TailnetSshTargetDescription {
  hostname: string;
  dnsName?: string;
  ips: string[];
  os?: string;
  identity: string;
  username: string;
  port: number;
  scope: string;
  network: "Tailscale";
  authMode: SshAuthMode;
  authentication: string;
  passwordRequired: false;
  nativeTailscaleSsh: boolean;
  remoteWorkspace: string;
}

interface PreparedConnection {
  device: TailscaleSshDevice;
  user: string;
  port: number;
  timeout: number;
  scope: string;
  authMode: SshAuthMode;
  host: string;
  controlPath: string;
  workspaceId: string;
  remoteWorkspace: string;
}

interface MasterResult {
  ok: boolean;
  created: boolean;
  reused: boolean;
  result: CommandResult;
  prepared: PreparedConnection;
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

function failure(stderr: string, exitCode: number | null = null): CommandResult {
  return {
    ok: false,
    stdout: "",
    stderr,
    timedOut: false,
    exitCode,
    signal: null,
  };
}

function boundedTimeout(value?: number): number {
  if (!Number.isFinite(value)) return 15_000;
  return Math.max(3_000, Math.min(Math.trunc(value ?? 15_000), 60_000));
}

function validatePort(value?: number): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Math.trunc(value);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("SSH port must be between 1 and 65535.");
  }
  return port;
}

function validateUser(value: string): string {
  const user = value.trim();
  if (!user || !/^[A-Za-z0-9._-]+$/u.test(user)) {
    throw new Error("SSH user is required and must contain only safe username characters.");
  }
  return user;
}

function normalizeScope(value?: string): string {
  const scope = value?.trim();
  if (!scope || scope.length > 256 || !/^[A-Za-z0-9:._-]+$/u.test(scope)) {
    return "session:unknown";
  }
  return scope;
}

function validateRemotePath(value: string): string {
  const remote = value.trim().replace(/\\/gu, "/");
  if (
    !remote ||
    remote.length > 4096 ||
    remote.startsWith("/") ||
    remote.startsWith("~") ||
    /^[A-Za-z]:/u.test(remote)
  ) {
    throw new Error("remote_path must be relative to this Topic's isolated SSH workspace.");
  }
  const segments = remote.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("-") ||
        !/^[A-Za-z0-9_@%+=,.-]+$/u.test(segment),
    )
  ) {
    throw new Error("remote_path contains unsupported or unsafe workspace path segments.");
  }
  return segments.join("/");
}

function clip(value: string): string {
  return value.length <= MAX_OUTPUT
    ? value
    : `…(truncated, ${value.length} chars total)\n${value.slice(-MAX_OUTPUT)}`;
}

export function sanitizeSshLog(value: string): string {
  return clip(value)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(password|passwd|token|secret|auth[-_]?key)\s*[=:]\s*\S+/giu, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
}

function classify(result: CommandResult, authMode: SshAuthMode): string {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("authorization expired") || output.includes("active ssh master")) {
    return "authorization-expired";
  }
  if (result.timedOut || output.includes("port 65535 timed out")) return "transport-timeout";
  if (output.includes("no matching key exchange method")) return "kex-mismatch";
  if (output.includes("kex_exchange_identification")) return "kex-handshake-failed";
  if (output.includes("host key verification failed") || output.includes("remote host identification has changed")) {
    return "host-identity-changed";
  }
  if (output.includes("connection refused")) return "connection-refused";
  if (output.includes("no route to host") || output.includes("network is unreachable")) {
    return "network-unreachable";
  }
  if (
    output.includes("permission denied") ||
    output.includes("access denied") ||
    output.includes("unable to authenticate")
  ) {
    return authMode === "managed-key"
      ? "managed-key-not-authorized"
      : "tailscale-ssh-policy-denied";
  }
  if (output.includes("could not resolve hostname") || output.includes("name or service not known")) {
    return "hostname-resolution-failed";
  }
  return "ssh-failed";
}

function proxyCommand(): string {
  return `${TAILSCALE_BIN} --socket=${getTailscaleSocketPath()} nc %h %p`;
}

function preferredHost(device: TailscaleSshDevice, authMode: SshAuthMode): string {
  if (authMode === "tailscale-ssh") return device.name;
  return device.ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/u.test(ip))
    ?? device.ips[0]
    ?? device.dnsName
    ?? device.name;
}

function authModeFor(device: TailscaleSshDevice, port: number): SshAuthMode {
  return port === DEFAULT_PORT && device.nativeTailscaleSsh
    ? "tailscale-ssh"
    : "managed-key";
}

function authLabel(authMode: SshAuthMode): string {
  return authMode === "tailscale-ssh"
    ? "Tailscale SSH (Tailnet identity)"
    : "Managed Ed25519 SSH key over Tailscale";
}

function connectionDigest(
  scope: string,
  device: TailscaleSshDevice,
  user: string,
  port: number,
): string {
  return createHash("sha256")
    .update([scope, device.identity, user, String(port)].join("\0"), "utf8")
    .digest("hex");
}

function controlPathFor(scope: string, device: TailscaleSshDevice, user: string, port: number): string {
  return path.join(CONTROL_DIR, `${connectionDigest(scope, device, user, port).slice(0, 32)}.sock`);
}

function authorizationLeaseKey(prepared: PreparedConnection): string {
  return connectionDigest(
    prepared.scope,
    prepared.device,
    prepared.user,
    prepared.port,
  );
}

function hasAuthorizationLease(prepared: PreparedConnection): boolean {
  return authorizationLeases.has(authorizationLeaseKey(prepared));
}

function remoteWorkspaceIdFor(
  scope: string,
  device: TailscaleSshDevice,
  user: string,
  port: number,
): string {
  return connectionDigest(scope, device, user, port).slice(0, 24);
}

function isWindowsDevice(device: TailscaleSshDevice): boolean {
  return device.os?.trim().toLowerCase() === "windows";
}

function remoteWorkspaceFor(device: TailscaleSshDevice, workspaceId: string): string {
  return isWindowsDevice(device)
    ? `%USERPROFILE%\\.opencode-telegram\\ssh-workspaces\\${workspaceId}`
    : `~/${REMOTE_WORKSPACE_ROOT}/${workspaceId}`;
}

function quotePosixShell(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function windowsWorkspaceCommand(
  prepared: PreparedConnection,
  command?: string,
  relativeDirectory?: string,
): string {
  const workspaceRelative = `${REMOTE_WORKSPACE_ROOT.replace(/\//gu, "\\")}\\${prepared.workspaceId}`;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$workspace = Join-Path $env:USERPROFILE '${workspaceRelative}'`,
    "New-Item -ItemType Directory -Force -Path $workspace | Out-Null",
  ];
  if (relativeDirectory) {
    const directory = relativeDirectory.replace(/\//gu, "\\");
    lines.push(
      `$targetDirectory = Join-Path $workspace '${directory}'`,
      "New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null",
    );
  }
  lines.push("Set-Location -LiteralPath $workspace");
  if (command !== undefined) {
    const encodedCommand = Buffer.from(command, "utf8").toString("base64");
    lines.push(
      `$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCommand}'))`,
      "& $env:ComSpec /d /s /c $command",
      "exit $LASTEXITCODE",
    );
  } else {
    lines.push("exit 0");
  }
  const encodedScript = Buffer.from(lines.join("; "), "utf16le").toString("base64");
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`;
}

function workspaceBootstrapCommand(
  prepared: PreparedConnection,
  relativeDirectory?: string,
): string {
  if (isWindowsDevice(prepared.device)) {
    return windowsWorkspaceCommand(prepared, undefined, relativeDirectory);
  }
  const suffix = relativeDirectory ? `/${relativeDirectory}` : "";
  return `umask 077; mkdir -p -- "$HOME/${REMOTE_WORKSPACE_ROOT}/${prepared.workspaceId}${suffix}"`;
}

function workspaceWrappedCommand(prepared: PreparedConnection, command: string): string {
  if (isWindowsDevice(prepared.device)) {
    return windowsWorkspaceCommand(prepared, command);
  }
  const workspace = `$HOME/${REMOTE_WORKSPACE_ROOT}/${prepared.workspaceId}`;
  return `umask 077; workspace="${workspace}"; mkdir -p -- "$workspace" && cd -- "$workspace" && eval ${quotePosixShell(command)}`;
}

function remoteTransferPath(prepared: PreparedConnection, remotePath: string): string {
  return `${REMOTE_WORKSPACE_ROOT}/${prepared.workspaceId}/${remotePath}`;
}

function hostKeyAlgorithms(device: TailscaleSshDevice): string {
  const values = [...new Set(
    device.sshHostKeys
      .map((key) => key.trim().split(/\s+/u)[0])
      .filter(
        (value): value is string =>
          typeof value === "string" &&
          value.length > 0 &&
          /^[A-Za-z0-9@._+-]+$/u.test(value),
      ),
  )];
  if (values.length === 0) throw new Error("Native Tailscale SSH peer did not advertise SSH host keys.");
  if (values.includes("ssh-ed25519")) {
    return ["ssh-ed25519", ...values.filter((value) => value !== "ssh-ed25519")].join(",");
  }
  return values.join(",");
}

async function nativeKnownHosts(device: TailscaleSshDevice): Promise<string> {
  if (device.sshHostKeys.length === 0) {
    throw new Error("Native Tailscale SSH peer did not advertise SSH host keys.");
  }
  await fs.mkdir(HOSTKEY_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(HOSTKEY_DIR, `${device.identity}.known_hosts`);
  const aliases = [...new Set([
    device.name,
    ...(device.dnsName ? [device.dnsName] : []),
    ...device.ips,
  ].filter(Boolean))];
  const lines = aliases.flatMap((alias) =>
    device.sshHostKeys.map((key) => `${alias} ${key.trim()}`),
  );
  await fs.writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return file;
}

async function connectionOptions(prepared: PreparedConnection, verbose = false): Promise<string[]> {
  const args = [
    ...(verbose ? ["-vvv"] : []),
    "-o", `ProxyCommand=${proxyCommand()}`,
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", `ConnectTimeout=${Math.max(3, Math.ceil(prepared.timeout / 1000))}`,
  ];

  if (prepared.authMode === "tailscale-ssh") {
    const knownHosts = await nativeKnownHosts(prepared.device);
    args.push(
      "-o", `KexAlgorithms=${NATIVE_KEX_ORDER}`,
      "-o", `HostKeyAlgorithms=${hostKeyAlgorithms(prepared.device)}`,
      "-o", `UserKnownHostsFile=${knownHosts}`,
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UpdateHostKeys=no",
      "-o", "CanonicalizeHostname=no",
    );
  } else {
    const privateKey = await getManagedSshPrivateKeyPath();
    const knownHosts = await getManagedSshKnownHostsPath();
    args.push(
      "-o", "PreferredAuthentications=publickey",
      "-o", "IdentitiesOnly=yes",
      "-o", `UserKnownHostsFile=${knownHosts}`,
      "-o", "StrictHostKeyChecking=accept-new",
      "-i", privateKey,
    );
  }
  return args;
}

async function prepare(input: TailnetSshTarget): Promise<PreparedConnection> {
  const user = validateUser(input.user);
  const port = validatePort(input.port);
  const timeout = boundedTimeout(input.timeoutMs);
  const scope = normalizeScope(input.scope);
  const device = await resolveTailscaleSshDevice(input.target);
  const authMode = authModeFor(device, port);
  const host = preferredHost(device, authMode);
  const workspaceId = remoteWorkspaceIdFor(scope, device, user, port);
  return {
    device,
    user,
    port,
    timeout,
    scope,
    authMode,
    host,
    controlPath: controlPathFor(scope, device, user, port),
    workspaceId,
    remoteWorkspace: remoteWorkspaceFor(device, workspaceId),
  };
}

async function masterCheck(
  prepared: PreparedConnection,
  runner: CommandRunner,
): Promise<CommandResult> {
  return runner({
    bin: SSH_BIN,
    args: [
      "-S", prepared.controlPath,
      "-O", "check",
      "-p", String(prepared.port),
      `${prepared.user}@${prepared.host}`,
    ],
    timeoutMs: Math.min(prepared.timeout, 5_000),
  });
}

async function startMaster(
  prepared: PreparedConnection,
  runner: CommandRunner,
  verbose = false,
): Promise<CommandResult> {
  await fs.mkdir(CONTROL_DIR, { recursive: true, mode: 0o700 });
  await fs.rm(prepared.controlPath, { force: true }).catch(() => {});
  const options = await connectionOptions(prepared, verbose);
  return runner({
    bin: SSH_BIN,
    args: [
      ...options,
      "-M",
      "-S", prepared.controlPath,
      "-o", "ControlMaster=yes",
      "-o", "ControlPersist=yes",
      "-N",
      "-f",
      "-p", String(prepared.port),
      `${prepared.user}@${prepared.host}`,
    ],
    timeoutMs: prepared.timeout,
  });
}

async function ensureMaster(
  prepared: PreparedConnection,
  allowStart: boolean,
  runner: CommandRunner,
  verbose = false,
): Promise<MasterResult> {
  const current = await masterCheck(prepared, runner);
  if (current.ok) {
    return { ok: true, created: false, reused: true, result: current, prepared };
  }
  if (!allowStart) {
    return {
      ok: false,
      created: false,
      reused: false,
      result: failure(
        "SSH authorization is required for this Topic/server identity, username, and port.",
      ),
      prepared,
    };
  }

  const existingLock = masterLocks.get(prepared.controlPath);
  if (existingLock) {
    const lockedResult = await existingLock;
    return {
      ok: lockedResult.ok,
      created: lockedResult.ok,
      reused: false,
      result: lockedResult,
      prepared,
    };
  }

  const operation = startMaster(prepared, runner, verbose)
    .finally(() => masterLocks.delete(prepared.controlPath));
  masterLocks.set(prepared.controlPath, operation);
  const result = await operation;
  return { ok: result.ok, created: result.ok, reused: false, result, prepared };
}

async function runOverMaster(
  prepared: PreparedConnection,
  command: string,
  runner: CommandRunner,
  verbose = false,
): Promise<CommandResult> {
  return runner({
    bin: SSH_BIN,
    args: [
      ...(verbose ? ["-vvv"] : []),
      "-S", prepared.controlPath,
      "-o", "ControlMaster=no",
      "-o", "ProxyCommand=/bin/false",
      "-p", String(prepared.port),
      `${prepared.user}@${prepared.host}`,
      command,
    ],
    timeoutMs: prepared.timeout,
  });
}

export async function resolveTailnetSshScope(sessionId: string): Promise<string> {
  const session = sessionId.trim();
  if (!session) return "session:unknown";
  const binding = await findTelegramTopicBindingBySessionId(session).catch(() => null);
  return binding
    ? `topic:${binding.chatId}:${binding.threadId}`
    : `session:${session}`;
}

export async function describeTailnetSshTarget(
  input: TailnetSshTarget,
): Promise<TailnetSshTargetDescription> {
  const prepared = await prepare(input);
  return {
    hostname: prepared.device.name,
    ...(prepared.device.dnsName ? { dnsName: prepared.device.dnsName } : {}),
    ips: prepared.device.ips,
    ...(prepared.device.os ? { os: prepared.device.os } : {}),
    identity: prepared.device.identity,
    username: prepared.user,
    port: prepared.port,
    scope: prepared.scope,
    network: "Tailscale",
    authMode: prepared.authMode,
    authentication: authLabel(prepared.authMode),
    passwordRequired: false,
    nativeTailscaleSsh: prepared.authMode === "tailscale-ssh",
    remoteWorkspace: prepared.remoteWorkspace,
  };
}

export async function hasActiveTailnetSshConnection(
  input: TailnetSshTarget,
  runner: CommandRunner = runCommand,
): Promise<boolean> {
  const prepared = await prepare(input);
  return (await masterCheck(prepared, runner)).ok;
}

export async function hasTailnetSshAuthorization(
  input: TailnetSshTarget,
): Promise<boolean> {
  return hasAuthorizationLease(await prepare(input));
}

export async function grantTailnetSshAuthorization(
  input: TailnetSshTarget,
): Promise<void> {
  const prepared = await prepare(input);
  authorizationLeases.add(authorizationLeaseKey(prepared));
}

function masterMetadata(master: MasterResult): Record<string, unknown> {
  return {
    persistentConnection: true,
    connectionCreated: master.created,
    connectionReused: master.reused,
    authorizationScope: master.prepared.scope,
    serverIdentity: master.prepared.device.identity,
    masterLossRequiresPermission: false,
    authorizationBoundary: "topic+server-identity+username+port",
    remoteWorkspace: master.prepared.remoteWorkspace,
    remoteWorkspaceScope: "topic+server-identity+username+port",
  };
}

export async function checkTailnetSsh(
  input: TailnetSshTarget,
  runner: CommandRunner = runCommand,
): Promise<Record<string, unknown>> {
  const prepared = await prepare(input);
  const ping = await pingTailscaleSshDevice(prepared.device.name);
  if (!ping.ok) {
    return {
      ok: false,
      device: prepared.device,
      user: prepared.user,
      port: prepared.port,
      tailnetReachable: false,
      diagnosis: "tailnet-unreachable",
      ping: ping.output,
    };
  }

  const master = await ensureMaster(
    prepared,
    input.allowConnectionStart === true || hasAuthorizationLease(prepared),
    runner,
  );
  return {
    ok: master.ok,
    device: prepared.device,
    user: prepared.user,
    port: prepared.port,
    tailnetReachable: true,
    authMode: prepared.authMode,
    authentication: authLabel(prepared.authMode),
    passwordRequired: false,
    diagnosis: master.ok
      ? master.created ? "connected-master-created" : "connected-master-reused"
      : classify(master.result, prepared.authMode),
    compatibility: prepared.authMode === "tailscale-ssh"
      ? "ecdh-nistp256-first"
      : "default",
    workingOverrides: prepared.authMode === "tailscale-ssh"
      ? [
          `ProxyCommand=${proxyCommand()}`,
          `KexAlgorithms=${NATIVE_KEX_ORDER}`,
          `HostKeyAlgorithms=${hostKeyAlgorithms(prepared.device)}`,
        ]
      : [],
    ...masterMetadata(master),
  };
}

export async function debugTailnetSsh(
  input: TailnetSshTarget,
  runner: CommandRunner = runCommand,
): Promise<Record<string, unknown>> {
  const prepared = await prepare(input);
  const ping = await pingTailscaleSshDevice(prepared.device.name);
  if (!ping.ok) {
    return {
      ok: false,
      device: prepared.device,
      user: prepared.user,
      port: prepared.port,
      tailnetReachable: false,
      diagnosis: "tailnet-unreachable",
      ping: ping.output,
    };
  }

  const master = await ensureMaster(
    prepared,
    input.allowConnectionStart === true || hasAuthorizationLease(prepared),
    runner,
    true,
  );
  return {
    ok: master.ok,
    device: prepared.device,
    user: prepared.user,
    port: prepared.port,
    tailnetReachable: true,
    authMode: prepared.authMode,
    authentication: authLabel(prepared.authMode),
    passwordRequired: false,
    diagnosis: master.ok
      ? master.created ? "connected-master-created" : "connected-master-reused"
      : classify(master.result, prepared.authMode),
    compatibility: prepared.authMode === "tailscale-ssh"
      ? "ecdh-nistp256-first"
      : "default",
    workingOverrides: prepared.authMode === "tailscale-ssh"
      ? [
          `ProxyCommand=${proxyCommand()}`,
          `KexAlgorithms=${NATIVE_KEX_ORDER}`,
          `HostKeyAlgorithms=${hostKeyAlgorithms(prepared.device)}`,
        ]
      : [],
    log: sanitizeSshLog(
      [master.result.stdout, master.result.stderr].filter(Boolean).join("\n"),
    ),
    ...masterMetadata(master),
  };
}

export async function execTailnetSsh(
  input: TailnetSshExecInput,
  runner: CommandRunner = runCommand,
): Promise<Record<string, unknown>> {
  const command = input.command.trim();
  if (!command || command.length > 8_000 || command.includes("\0")) {
    throw new Error("SSH command is empty or invalid.");
  }

  const prepared = await prepare(input);
  const master = await ensureMaster(
    prepared,
    input.allowConnectionStart === true || hasAuthorizationLease(prepared),
    runner,
  );
  if (!master.ok) {
    return {
      ok: false,
      device: prepared.device,
      user: prepared.user,
      port: prepared.port,
      authMode: prepared.authMode,
      authentication: authLabel(prepared.authMode),
      passwordRequired: false,
      diagnosis: classify(master.result, prepared.authMode),
      stdout: "",
      stderr: sanitizeSshLog(master.result.stderr),
      exitCode: master.result.exitCode,
      ...masterMetadata(master),
    };
  }

  const result = await runOverMaster(
    prepared,
    workspaceWrappedCommand(prepared, command),
    runner,
  );
  return {
    ok: result.ok,
    device: prepared.device,
    user: prepared.user,
    port: prepared.port,
    authMode: prepared.authMode,
    authentication: authLabel(prepared.authMode),
    passwordRequired: false,
    diagnosis: result.ok ? "completed-over-master" : classify(result, prepared.authMode),
    compatibility: prepared.authMode === "tailscale-ssh"
      ? "ecdh-nistp256-first"
      : "default",
    stdout: sanitizeSshLog(result.stdout),
    stderr: sanitizeSshLog(result.stderr),
    exitCode: result.exitCode,
    ...masterMetadata(master),
  };
}

async function scpOverMaster(
  prepared: PreparedConnection,
  localPath: string,
  remotePath: string,
  direction: "upload" | "download",
  runner: CommandRunner,
): Promise<CommandResult> {
  const remote = `${prepared.user}@${prepared.host}:${remoteTransferPath(prepared, remotePath)}`;
  return runner({
    bin: SCP_BIN,
    args: [
      "-o", `ControlPath=${prepared.controlPath}`,
      "-o", "ControlMaster=no",
      "-o", "ProxyCommand=/bin/false",
      "-P", String(prepared.port),
      direction === "upload" ? localPath : remote,
      direction === "upload" ? remote : localPath,
    ],
    timeoutMs: prepared.timeout,
  });
}

export async function transferTailnetSshFile(
  input: TailnetSshTransferInput,
  runner: CommandRunner = runCommand,
): Promise<Record<string, unknown>> {
  const prepared = await prepare(input);
  const remotePath = validateRemotePath(input.remotePath);
  const localPath = path.resolve(input.localPath);

  if (input.direction === "upload") {
    const stat = await fs.stat(localPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error("Upload source must be an existing regular file.");
    }
  } else {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
  }

  const master = await ensureMaster(
    prepared,
    input.allowConnectionStart === true || hasAuthorizationLease(prepared),
    runner,
  );
  if (!master.ok) {
    return {
      ok: false,
      device: prepared.device,
      user: prepared.user,
      port: prepared.port,
      direction: input.direction,
      authMode: prepared.authMode,
      authentication: authLabel(prepared.authMode),
      passwordRequired: false,
      diagnosis: classify(master.result, prepared.authMode),
      stderr: sanitizeSshLog(master.result.stderr),
      ...masterMetadata(master),
    };
  }

  const parentDirectory = input.direction === "upload"
    ? path.posix.dirname(remotePath)
    : undefined;
  const workspaceReady = await runOverMaster(
    prepared,
    workspaceBootstrapCommand(
      prepared,
      parentDirectory && parentDirectory !== "." ? parentDirectory : undefined,
    ),
    runner,
  );
  if (!workspaceReady.ok) {
    return {
      ok: false,
      device: prepared.device,
      user: prepared.user,
      port: prepared.port,
      direction: input.direction,
      authMode: prepared.authMode,
      authentication: authLabel(prepared.authMode),
      passwordRequired: false,
      diagnosis: classify(workspaceReady, prepared.authMode),
      stderr: sanitizeSshLog(workspaceReady.stderr),
      ...masterMetadata(master),
    };
  }

  const result = await scpOverMaster(
    prepared,
    localPath,
    remotePath,
    input.direction,
    runner,
  );
  const bytes = result.ok
    ? (await fs.stat(localPath).catch(() => null))?.size ?? null
    : null;

  return {
    ok: result.ok,
    device: prepared.device,
    user: prepared.user,
    port: prepared.port,
    direction: input.direction,
    authMode: prepared.authMode,
    authentication: authLabel(prepared.authMode),
    passwordRequired: false,
    diagnosis: result.ok ? "completed-over-master" : classify(result, prepared.authMode),
    bytes,
    localPath,
    remotePath,
    stderr: result.ok ? "" : sanitizeSshLog(result.stderr),
    ...masterMetadata(master),
  };
}

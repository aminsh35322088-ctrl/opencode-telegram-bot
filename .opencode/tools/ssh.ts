import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

const SSH_BIN = "/usr/bin/ssh";
const SCP_BIN = "/usr/bin/scp";
const SSH_KEYGEN_BIN = "/usr/bin/ssh-keygen";
const SSH_DIR = "/data/.ssh";
const IDENTITY_FILE = `${SSH_DIR}/opencode_ed25519`;
const PUBLIC_KEY_FILE = `${IDENTITY_FILE}.pub`;
const KNOWN_HOSTS_FILE = `${SSH_DIR}/known_hosts`;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 64_000;

type RemoteAction = "exec" | "read" | "write" | "upload" | "download";

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function clip(value: string): string {
  if (value.length <= MAX_OUTPUT) return value;
  const half = Math.floor((MAX_OUTPUT - 80) / 2);
  return `${value.slice(0, half)}\n… output truncated …\n${value.slice(-half)}`;
}

function validateHost(value: string | undefined): string {
  const host = value?.trim() ?? "";
  if (!host) throw new Error("host is required");
  if (host.length > 253 || host.startsWith("-") || /[\s/@]/.test(host)) {
    throw new Error("host contains unsupported characters");
  }
  if (isIP(host)) return host;
  if (!/^[A-Za-z0-9._-]+$/.test(host) || host.includes("..")) {
    throw new Error("host must be a hostname or IP address");
  }
  return host;
}

function validateUser(value: string | undefined): string {
  const user = value?.trim() ?? "";
  if (!user) throw new Error("user is required");
  if (user.length > 64 || user.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new Error("user contains unsupported characters");
  }
  return user;
}

function validatePort(value: number | undefined): number {
  const port = value ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return port;
}

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout)) throw new Error("timeoutMs must be a finite number");
  return Math.max(3_000, Math.min(Math.trunc(timeout), MAX_TIMEOUT_MS));
}

function validateRemotePath(value: string | undefined): string {
  const remotePath = value?.trim() ?? "";
  if (!remotePath) throw new Error("remotePath is required");
  if (remotePath.length > 4096 || /[\0\r\n]/.test(remotePath)) {
    throw new Error("remotePath contains unsupported characters");
  }
  return remotePath;
}

function validateTransferRemotePath(value: string): string {
  if (!/^[A-Za-z0-9_./~+@-]+$/.test(value)) {
    throw new Error("upload/download remotePath is limited to safe path characters");
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sshTarget(user: string, host: string): string {
  return `${user}@${host}`;
}

function scpTarget(user: string, host: string): string {
  return isIP(host) === 6 ? `${user}@[${host}]` : `${user}@${host}`;
}

function commonOptions(port: number, scp = false): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS_FILE}`,
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-i", IDENTITY_FILE,
    scp ? "-P" : "-p", String(port),
  ];
}

async function ensureIdentity(): Promise<void> {
  await mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
  await chmod(SSH_DIR, 0o700);

  try {
    const keyStat = await stat(IDENTITY_FILE);
    if (!keyStat.isFile()) throw new Error("SSH identity path is not a regular file");
    await chmod(IDENTITY_FILE, 0o600);
    try { await chmod(PUBLIC_KEY_FILE, 0o644); } catch {}
    return;
  } catch (error) {
    if (error instanceof Error && error.message === "SSH identity path is not a regular file") throw error;
  }

  await execFileAsync(
    SSH_KEYGEN_BIN,
    ["-q", "-t", "ed25519", "-N", "", "-C", "opencode-telegram-bot", "-f", IDENTITY_FILE],
    { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
  );
  await chmod(IDENTITY_FILE, 0o600);
  await chmod(PUBLIC_KEY_FILE, 0o644);
}

async function fingerprint(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      SSH_KEYGEN_BIN,
      ["-lf", PUBLIC_KEY_FILE, "-E", "sha256"],
      { timeout: 5_000, maxBuffer: 512 * 1024 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function sshVersion(): Promise<string | null> {
  try {
    const { stderr, stdout } = await execFileAsync(SSH_BIN, ["-V"], {
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    });
    return `${stderr}${stdout}`.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

async function runProcess(
  binary: string,
  args: string[],
  timeoutMs: number,
  input?: string,
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = clip(stdout + String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = clip(stderr + String(chunk));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
      });
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function resolveLocalPath(base: string, candidate: string | undefined): string {
  const requested = candidate?.trim() ?? "";
  if (!requested) throw new Error("localPath is required");

  const root = path.resolve(base);
  const resolved = path.resolve(root, requested);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("localPath must stay inside the current worktree");
  }
  return resolved;
}

function remoteBase(
  action: RemoteAction,
  host: string,
  user: string,
  port: number,
  completed: ProcessResult,
): Record<string, unknown> {
  return {
    ok: completed.code === 0 && !completed.timedOut,
    action,
    host,
    user,
    port,
    exitCode: completed.code,
    timedOut: completed.timedOut,
  };
}

export default tool({
  description: "Direct, key-only SSH client for remote servers. Uses a bot-owned persistent Ed25519 identity under /data/.ssh. The private key and passwords are never model-facing. Supports remote command execution and bounded file transfer.",
  args: {
    action: tool.schema.enum(["status", "key.ensure", "key.public", "exec", "read", "write", "upload", "download"]),
    host: tool.schema.string().optional().describe("Remote hostname or IP address. Required for remote actions."),
    user: tool.schema.string().optional().describe("Remote SSH username. Required for remote actions."),
    port: tool.schema.number().optional().describe("SSH port. Defaults to 22."),
    command: tool.schema.string().optional().describe("Remote command for exec."),
    remotePath: tool.schema.string().optional().describe("Remote file path for read/write/upload/download."),
    localPath: tool.schema.string().optional().describe("Worktree-relative local file path for upload/download."),
    content: tool.schema.string().optional().describe("Text content for write. Do not use this argument for credentials."),
    timeoutMs: tool.schema.number().optional().describe("Operation timeout in milliseconds, clamped to 3s-120s."),
  },
  async execute(args, context) {
    const action = String(args.action);

    if (action === "status") {
      let identityReady = false;
      try { identityReady = (await stat(IDENTITY_FILE)).isFile(); } catch {}
      return json({
        ok: true,
        ssh: await sshVersion(),
        identityReady,
        fingerprint: identityReady ? await fingerprint() : null,
        identity: "bot-owned-ed25519",
        knownHosts: KNOWN_HOSTS_FILE,
      });
    }

    if (action === "key.ensure") {
      await ensureIdentity();
      return json({
        ok: true,
        identity: "bot-owned-ed25519",
        fingerprint: await fingerprint(),
      });
    }

    if (action === "key.public") {
      await ensureIdentity();
      return json({
        ok: true,
        fingerprint: await fingerprint(),
        publicKey: (await readFile(PUBLIC_KEY_FILE, "utf8")).trim(),
      });
    }

    await ensureIdentity();

    const host = validateHost(args.host);
    const user = validateUser(args.user);
    const port = validatePort(args.port);
    const timeoutMs = validateTimeout(args.timeoutMs);
    const target = sshTarget(user, host);

    if (action === "exec") {
      const command = args.command?.trim() ?? "";
      if (!command) return json({ ok: false, action, error: "command is required" });
      const completed = await runProcess(
        SSH_BIN,
        [...commonOptions(port), "-T", target, command],
        timeoutMs,
      );
      return json({
        ...remoteBase("exec", host, user, port, completed),
        stdout: clip(completed.stdout),
        stderr: clip(completed.stderr),
      });
    }

    const remotePath = validateRemotePath(args.remotePath);

    if (action === "read") {
      const completed = await runProcess(
        SSH_BIN,
        [...commonOptions(port), "-T", target, `cat -- ${shellQuote(remotePath)}`],
        timeoutMs,
      );
      return json({
        ...remoteBase("read", host, user, port, completed),
        remotePath,
        content: clip(completed.stdout),
        stderr: clip(completed.stderr),
      });
    }

    if (action === "write") {
      if (args.content === undefined) return json({ ok: false, action, error: "content is required" });
      const completed = await runProcess(
        SSH_BIN,
        [...commonOptions(port), "-T", target, `umask 077; cat > ${shellQuote(remotePath)}`],
        timeoutMs,
        args.content,
      );
      return json({
        ...remoteBase("write", host, user, port, completed),
        remotePath,
        stderr: clip(completed.stderr),
      });
    }

    const base = context.directory || context.worktree || process.cwd();
    const localPath = resolveLocalPath(base, args.localPath);
    const transferRemotePath = validateTransferRemotePath(remotePath);
    const transferTarget = scpTarget(user, host);

    if (action === "upload") {
      const localStat = await stat(localPath).catch(() => null);
      if (!localStat?.isFile()) {
        return json({ ok: false, action, error: "localPath must reference an existing regular file" });
      }
      const completed = await runProcess(
        SCP_BIN,
        [...commonOptions(port, true), localPath, `${transferTarget}:${transferRemotePath}`],
        timeoutMs,
      );
      return json({
        ...remoteBase("upload", host, user, port, completed),
        localPath,
        remotePath: transferRemotePath,
        stderr: clip(completed.stderr),
      });
    }

    await mkdir(path.dirname(localPath), { recursive: true });
    const completed = await runProcess(
      SCP_BIN,
      [...commonOptions(port, true), `${transferTarget}:${transferRemotePath}`, localPath],
      timeoutMs,
    );
    return json({
      ...remoteBase("download", host, user, port, completed),
      localPath,
      remotePath: transferRemotePath,
      stderr: clip(completed.stderr),
    });
  },
});

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const SSH_BIN = "/usr/bin/ssh";
const SCP_BIN = "/usr/bin/scp";
const SSH_KEYGEN_BIN = "/usr/bin/ssh-keygen";
const SSH_DIR = "/data/.ssh";
const IDENTITY_FILE = `${SSH_DIR}/opencode_ed25519`;
const PUBLIC_KEY_FILE = `${IDENTITY_FILE}.pub`;
const KNOWN_HOSTS_FILE = `${SSH_DIR}/known_hosts`;
const MAX_OUTPUT = 32_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function result(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function clip(value: string): string {
  return value.length <= MAX_OUTPUT ? value : value.slice(-MAX_OUTPUT);
}

function clampTimeout(value?: number): number {
  return Math.max(3_000, Math.min(Math.trunc(value ?? DEFAULT_TIMEOUT_MS), 120_000));
}

function validateHost(value: string | undefined): string {
  const host = value?.trim() ?? "";
  if (!host) throw new Error("host is required");
  if (host.length > 253 || !/^[A-Za-z0-9._:-]+$/.test(host)) {
    throw new Error("host contains unsupported characters");
  }
  return host;
}

function validateUser(value: string | undefined): string {
  const user = value?.trim() ?? "";
  if (!user) throw new Error("user is required");
  if (user.length > 64 || !/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new Error("user contains unsupported characters");
  }
  return user;
}

function validatePort(value?: number): number {
  const port = Math.trunc(value ?? 22);
  if (port < 1 || port > 65535) throw new Error("port must be between 1 and 65535");
  return port;
}

function validateRemotePath(value: string): string {
  const remotePath = value.trim();
  if (!remotePath) throw new Error("remotePath is required");
  if (remotePath.length > 4096 || /[\0\r\n]/.test(remotePath)) {
    throw new Error("remotePath contains unsupported characters");
  }
  return remotePath;
}

function validateTransferRemotePath(value: string): string {
  const remotePath = validateRemotePath(value);
  if (!/^[A-Za-z0-9_./~+@-]+$/.test(remotePath)) {
    throw new Error("upload/download remotePath is limited to safe path characters");
  }
  return remotePath;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function ensureKey(): Promise<void> {
  await mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
  try {
    const keyStat = await stat(IDENTITY_FILE);
    if (keyStat.isFile()) return;
  } catch {}
  await execFileAsync(SSH_KEYGEN_BIN, [
    "-t", "ed25519",
    "-N", "",
    "-C", "opencode-telegram-bot",
    "-f", IDENTITY_FILE,
  ], {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function localVersion(): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(SSH_BIN, ["-V"], {
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    });
    return `${stdout}${stderr}`.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

function sshOptions(port: number): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS_FILE}`,
    "-o", "ConnectTimeout=15",
    "-i", IDENTITY_FILE,
    "-p", String(port),
  ];
}

function scpOptions(port: number): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS_FILE}`,
    "-o", "ConnectTimeout=15",
    "-i", IDENTITY_FILE,
    "-P", String(port),
  ];
}

async function runProcess(
  binary: string,
  args: string[],
  timeoutMs: number,
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout = clip(stdout + String(chunk)); });
    child.stderr.on("data", (chunk) => { stderr = clip(stderr + String(chunk)); });
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
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function resolveLocalPath(base: string, candidate: string): string {
  const root = path.resolve(base);
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("local path must stay inside the current worktree");
  }
  return resolved;
}

export default tool({
  description: "Secure direct SSH client using a persistent bot-owned Ed25519 key. Supports command execution and bounded file transfer without exposing private keys to the model.",
  args: {
    action: tool.schema.enum(["status", "key.ensure", "key.public", "exec", "read", "write", "upload", "download"]),
    host: tool.schema.string().optional().describe("SSH hostname or IP. Required for remote actions."),
    user: tool.schema.string().optional().describe("SSH username. Required for remote actions."),
    port: tool.schema.number().optional().describe("SSH port, default 22."),
    command: tool.schema.string().optional().describe("Remote command for exec."),
    remotePath: tool.schema.string().optional().describe("Remote path for read/write/upload/download."),
    localPath: tool.schema.string().optional().describe("Worktree-relative local path for upload/download."),
    content: tool.schema.string().optional().describe("Content for write. Avoid using this for secrets."),
    timeoutMs: tool.schema.number().optional().describe("Timeout in milliseconds, 3000-120000."),
  },
  async execute(args, context) {
    const action = String(args.action);

    if (action === "status") {
      let keyReady = false;
      try { keyReady = (await stat(IDENTITY_FILE)).isFile(); } catch {}
      return result({
        ok: true,
        ssh: await localVersion(),
        keyReady,
        identity: keyReady ? PUBLIC_KEY_FILE : null,
      });
    }

    if (action === "key.ensure") {
      await ensureKey();
      return result({ ok: true, publicKeyFile: PUBLIC_KEY_FILE });
    }

    if (action === "key.public") {
      await ensureKey();
      return result({ ok: true, publicKey: (await readFile(PUBLIC_KEY_FILE, "utf8")).trim() });
    }

    await ensureKey();
    const host = validateHost(args.host);
    const user = validateUser(args.user);
    const port = validatePort(args.port);
    const timeoutMs = clampTimeout(args.timeoutMs);
    const target = `${user}@${host}`;

    if (action === "exec") {
      const command = args.command?.trim();
      if (!command) return result({ ok: false, action, error: "command is required" });
      const completed = await runProcess(SSH_BIN, [...sshOptions(port), target, command], timeoutMs);
      return result({
        ok: completed.code === 0,
        action,
        host,
        user,
        port,
        exitCode: completed.code,
        stdout: clip(completed.stdout),
        stderr: clip(completed.stderr),
      });
    }

    const rawRemotePath = args.remotePath;
    if (!rawRemotePath?.trim()) return result({ ok: false, action, error: "remotePath is required" });
    const remotePath = validateRemotePath(rawRemotePath);

    if (action === "read") {
      const completed = await runProcess(
        SSH_BIN,
        [...sshOptions(port), target, `cat -- ${shellQuote(remotePath)}`],
        timeoutMs,
      );
      return result({
        ok: completed.code === 0,
        action,
        host,
        remotePath,
        exitCode: completed.code,
        content: clip(completed.stdout),
        stderr: clip(completed.stderr),
      });
    }

    if (action === "write") {
      if (args.content === undefined) return result({ ok: false, action, error: "content is required" });
      const completed = await runProcess(
        SSH_BIN,
        [...sshOptions(port), target, `umask 077; cat > ${shellQuote(remotePath)}`],
        timeoutMs,
        args.content,
      );
      return result({
        ok: completed.code === 0,
        action,
        host,
        remotePath,
        exitCode: completed.code,
        stderr: clip(completed.stderr),
      });
    }

    const base = context.directory || context.worktree || process.cwd();
    const localPath = args.localPath?.trim();
    if (!localPath) return result({ ok: false, action, error: "localPath is required" });
    const resolvedLocalPath = resolveLocalPath(base, localPath);
    const transferRemotePath = validateTransferRemotePath(remotePath);

    if (action === "upload") {
      const localStat = await stat(resolvedLocalPath).catch(() => null);
      if (!localStat?.isFile()) {
        return result({ ok: false, action, error: "localPath must reference an existing file" });
      }
      const completed = await runProcess(
        SCP_BIN,
        [...scpOptions(port), resolvedLocalPath, `${target}:${transferRemotePath}`],
        timeoutMs,
      );
      return result({
        ok: completed.code === 0,
        action,
        host,
        localPath: resolvedLocalPath,
        remotePath: transferRemotePath,
        exitCode: completed.code,
        stderr: clip(completed.stderr),
      });
    }

    await mkdir(path.dirname(resolvedLocalPath), { recursive: true });
    const completed = await runProcess(
      SCP_BIN,
      [...scpOptions(port), `${target}:${transferRemotePath}`, resolvedLocalPath],
      timeoutMs,
    );
    return result({
      ok: completed.code === 0,
      action,
      host,
      localPath: resolvedLocalPath,
      remotePath: transferRemotePath,
      exitCode: completed.code,
      stderr: clip(completed.stderr),
    });
  },
});

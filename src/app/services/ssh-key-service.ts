import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SSH_KEYGEN_BIN = process.env.SSH_KEYGEN_BIN?.trim() || "/usr/bin/ssh-keygen";
const KEY_DIR = process.env.SSH_KEY_DIR?.trim() || "/data/ssh";
const PRIVATE_KEY = path.join(KEY_DIR, "id_ed25519");
const PUBLIC_KEY = `${PRIVATE_KEY}.pub`;
const KNOWN_HOSTS = path.join(KEY_DIR, "known_hosts");
const LOCK_FILE = path.join(KEY_DIR, ".keygen.lock");

async function exists(file: string): Promise<boolean> {
  return fs.access(file, constants.F_OK).then(() => true).catch(() => false);
}
async function ensurePermissions(): Promise<void> {
  await fs.chmod(KEY_DIR, 0o700).catch(() => {});
  await fs.chmod(PRIVATE_KEY, 0o600).catch(() => {});
  await fs.chmod(PUBLIC_KEY, 0o644).catch(() => {});
}
async function generateKeypair(): Promise<void> {
  const temp = path.join(KEY_DIR, `.id_ed25519.${process.pid}.${Date.now()}`);
  await execFileAsync(SSH_KEYGEN_BIN, [
    "-q", "-t", "ed25519", "-N", "", "-C", "opencode-bot@tailscale", "-f", temp,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  await fs.chmod(temp, 0o600);
  await fs.chmod(`${temp}.pub`, 0o644);
  await fs.rename(temp, PRIVATE_KEY);
  await fs.rename(`${temp}.pub`, PUBLIC_KEY);
}

export async function ensureManagedSshKeypair(): Promise<void> {
  await fs.mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  if (await exists(PRIVATE_KEY) && await exists(PUBLIC_KEY)) {
    await ensurePermissions();
    return;
  }
  let lock: Awaited<ReturnType<typeof fs.open>> | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      lock = await fs.open(LOCK_FILE, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await exists(PRIVATE_KEY) && await exists(PUBLIC_KEY)) {
        await ensurePermissions();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!lock) throw new Error("Timed out waiting for SSH key generation lock.");
  try {
    if (!await exists(PRIVATE_KEY) || !await exists(PUBLIC_KEY)) await generateKeypair();
    await ensurePermissions();
  } finally {
    await lock.close().catch(() => {});
    await fs.rm(LOCK_FILE, { force: true }).catch(() => {});
  }
}
export async function getManagedSshPrivateKeyPath(): Promise<string> {
  await ensureManagedSshKeypair();
  return PRIVATE_KEY;
}
export async function getManagedSshPublicKey(): Promise<string> {
  await ensureManagedSshKeypair();
  return (await fs.readFile(PUBLIC_KEY, "utf8")).trim();
}
export async function getManagedSshKnownHostsPath(): Promise<string> {
  await fs.mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  await fs.appendFile(KNOWN_HOSTS, "", { mode: 0o600 });
  await fs.chmod(KNOWN_HOSTS, 0o600).catch(() => {});
  return KNOWN_HOSTS;
}

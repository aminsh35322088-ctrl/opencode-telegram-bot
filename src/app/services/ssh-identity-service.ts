import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function sshDir(): string {
  return path.join(process.env.OPENCODE_TELEGRAM_HOME ?? "/data", ".ssh");
}

export function getSshIdentityPaths(): { identityFile: string; publicKeyFile: string; knownHostsFile: string } {
  const dir = sshDir();
  const identityFile = path.join(dir, "opencode_ed25519");
  return {
    identityFile,
    publicKeyFile: `${identityFile}.pub`,
    knownHostsFile: path.join(dir, "known_hosts"),
  };
}

export async function ensureSshIdentity(): Promise<{ identityFile: string; publicKeyFile: string; knownHostsFile: string }> {
  const paths = getSshIdentityPaths();
  await mkdir(path.dirname(paths.identityFile), { recursive: true, mode: 0o700 });
  try {
    const current = await stat(paths.identityFile);
    if (current.isFile()) return paths;
  } catch {}

  await execFileAsync("/usr/bin/ssh-keygen", [
    "-t", "ed25519",
    "-N", "",
    "-C", "opencode-telegram-bot",
    "-f", paths.identityFile,
  ], {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return paths;
}

export async function getSshPublicKey(): Promise<string> {
  const paths = await ensureSshIdentity();
  return (await readFile(paths.publicKeyFile, "utf8")).trim();
}

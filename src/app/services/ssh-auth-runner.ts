import { execFile } from "node:child_process";
import { accessSync, constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadSshCredential } from "./ssh-credential-store.js";
import type { CommandRequest, CommandResult, CommandRunner } from "./ssh-service.js";

const execFileAsync = promisify(execFile);
const SSH_BIN = process.env.SSH_REAL_BIN?.trim() || "/usr/bin/ssh";
const SCP_BIN = process.env.SCP_REAL_BIN?.trim() || "/usr/bin/scp";
const TAILSCALE_BIN = process.env.TAILSCALE_BIN?.trim() || "/usr/local/bin/tailscale";

async function defaultRunner(request: CommandRequest): Promise<CommandResult> {
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

function findExecutable(bin: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(bin)) return bin;
  const name = process.platform === "win32" && !bin.toLowerCase().endsWith(".exe") ? `${bin}.exe` : bin;
  for (const directory of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue.
    }
  }
  return bin;
}


function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function materializeAuth(
  credentialId: string,
  request: CommandRequest,
  baseRunner: CommandRunner,
): Promise<CommandResult> {
  const credential = await loadSshCredential(credentialId);
  if (!credential) {
    return { ok: false, stdout: "", stderr: `SSH credential "${credentialId}" was not found.`, timedOut: false, exitCode: null, signal: null };
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-ssh-auth-"));
  try {
    const env: NodeJS.ProcessEnv = { ...(request.env ?? process.env) };
    const authOptions: string[] = [];

    if (credential.mode === "private-key") {
      const keyPath = path.join(directory, "identity");
      await fs.writeFile(keyPath, credential.privateKey, { mode: 0o600 });
      authOptions.push("-i", keyPath, "-o", "IdentitiesOnly=yes");
    } else {
      const askpass = path.join(directory, "askpass");
      await fs.writeFile(askpass, '#!/bin/sh\nprintf "%s\\n" "$OPENCODE_SSH_PASSWORD"\n', { mode: 0o700 });
      env.OPENCODE_SSH_PASSWORD = credential.password;
      env.SSH_ASKPASS = askpass;
      env.SSH_ASKPASS_REQUIRE = "force";
      env.DISPLAY = env.DISPLAY || "opencode-ssh:0";
      authOptions.push("-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no");
    }

    if (request.bin === SSH_BIN || request.bin === SCP_BIN) {
      return baseRunner({ ...request, args: [...authOptions, ...request.args], env });
    }

    if (request.bin === TAILSCALE_BIN && request.args[0] === "ssh") {
      const oldEnv = request.env ?? process.env;
      const underlying = findExecutable("ssh", oldEnv);
      const shim = path.join(directory, "ssh");
      const fixed = authOptions.map(quote).join(" ");
      await fs.writeFile(shim, `#!/bin/sh\nexec ${quote(underlying)} ${fixed} "$@"\n`, { mode: 0o700 });
      env.PATH = `${directory}${path.delimiter}${oldEnv.PATH ?? process.env.PATH ?? ""}`;
      return baseRunner({ ...request, env });
    }

    return baseRunner({ ...request, env });
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function sshCredentialRunner(credentialId?: string, baseRunner: CommandRunner = defaultRunner): CommandRunner {
  const id = credentialId?.trim();
  if (!id) return baseRunner;
  return (request) => materializeAuth(id, request, baseRunner);
}

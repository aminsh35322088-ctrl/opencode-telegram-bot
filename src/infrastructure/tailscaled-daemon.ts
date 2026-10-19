import type { ChildProcess, SpawnOptions } from "node:child_process";
import { budgetedSpawn } from "../runtime/process-budget.js";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface TailscaledPaths {
  readonly stateDir: string;
  readonly socketDir: string;
  readonly socket: string;
  readonly state: string;
  readonly log: string;
  readonly binary: string;
}

export function resolveTailscaledPaths(env: NodeJS.ProcessEnv = process.env): TailscaledPaths {
  const stateDir = env.TAILSCALE_STATE_DIR?.trim() || "/data/tailscale";
  const socketDir = env.TAILSCALE_SOCKET_DIR?.trim() || "/data/run/tailscale";
  return {
    stateDir,
    socketDir,
    socket: env.TAILSCALE_SOCKET?.trim() || path.join(socketDir, "tailscaled.sock"),
    state: path.join(stateDir, "tailscaled.state"),
    log: env.TAILSCALE_LOG?.trim() || "/data/logs/tailscaled.log",
    binary: env.TAILSCALE_BIN?.trim() || "/usr/local/bin/tailscaled",
  };
}

export interface StartTailscaledResult {
  readonly ok: boolean;
  readonly pid?: number;
  readonly reason?: "exited-before-socket" | "timeout" | "spawn-error";
}

export interface StartTailscaledOptions {
  readonly paths?: TailscaledPaths;
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly gemmLimit?: string;
  readonly gomaxprocs?: string;
  /** Test seam: runs after the child is spawned, before socket polling. */
  readonly afterSpawn?: () => Promise<void>;
}

export async function startTailscaledDaemon(
  options: StartTailscaledOptions = {},
): Promise<StartTailscaledResult> {
  const paths = options.paths ?? resolveTailscaledPaths();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;

  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.socketDir, { recursive: true });
  await fs.rm(paths.socket, { force: true });

  const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const owned = runningAsRoot && options.uid !== undefined && options.gid !== undefined;
  if (owned) {
    await fs.chown(paths.stateDir, options.uid!, options.gid!).catch((error) => {
      process.stderr.write(`[Tailscaled] chown state directory failed: ${String(error)}\n`);
    });
    await fs.chown(paths.socketDir, options.uid!, options.gid!).catch((error) => {
      process.stderr.write(`[Tailscaled] chown socket directory failed: ${String(error)}\n`);
    });
  }

  await fs.mkdir(path.dirname(paths.log), { recursive: true }).catch(() => {});
  const logHandle = await fs.open(paths.log, "a", 0o640);
  if (owned) {
    await logHandle.chown(options.uid!, options.gid!).catch(() => {});
  }
  const logFd = logHandle.fd;

  let child: ChildProcess;
  try {
    const args = ["--tun=userspace-networking", `--state=${paths.state}`, `--socket=${paths.socket}`];
    const spawnOptions: SpawnOptions = {
        stdio: ["ignore", logFd, logFd],
        detached: false,
        ...(options.uid !== undefined ? { uid: options.uid } : {}),
        ...(options.gid !== undefined ? { gid: options.gid } : {}),
        env: {
          ...process.env,
          GOMEMLIMIT: options.gemmLimit ?? process.env.TAILSCALED_GOMEMLIMIT?.trim() ?? "160MiB",
          GOMAXPROCS: options.gomaxprocs ?? process.env.TAILSCALED_GOMAXPROCS?.trim() ?? "1",
        },
      };
    child = options.spawn
      ? options.spawn(paths.binary, args, spawnOptions)
      : await budgetedSpawn("tailscale", paths.binary, args, spawnOptions);
  } catch {
    await logHandle.close().catch(() => {});
    return { ok: false, reason: "spawn-error" };
  }

  try {
    const outcome = await new Promise<StartTailscaledResult>((resolve) => {
      let settled = false;
      const finish = (result: StartTailscaledResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.once("error", () => finish({ ok: false, reason: "spawn-error" }));
      child.once("exit", () => finish({ ok: false, reason: "exited-before-socket" }));
      void (async () => {
        if (options.afterSpawn) await options.afterSpawn().catch(() => {});
        const deadline = Date.now() + timeoutMs;
        while (!settled && Date.now() < deadline) {
          const ready = await fs.stat(paths.socket).then((stat) => stat.isSocket()).catch(() => false);
          if (ready) {
            finish({ ok: true, pid: child.pid });
            return;
          }
          await new Promise((poll) => setTimeout(poll, pollMs));
        }
        finish({ ok: false, reason: "timeout" });
      })();
    });
    if (!outcome.ok) child.kill("SIGTERM");
    return outcome;
  } finally {
    await logHandle.close().catch(() => {});
  }
}

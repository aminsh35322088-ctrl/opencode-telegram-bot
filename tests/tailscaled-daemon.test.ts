import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  resolveTailscaledPaths,
  startTailscaledDaemon,
  type TailscaledPaths,
} from '../src/infrastructure/tailscaled-daemon.js';

function fakeChild(): EventEmitter & { kill: (signal?: NodeJS.Signals | number) => boolean; pid: number } {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>;
  child.pid = 4242;
  child.kill = () => true;
  return child;
}

function spawnRecorder(child = fakeChild()) {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const spawn = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return child;
  };
  return { child, calls, spawn: spawn as never };
}

async function makePaths(name: string): Promise<TailscaledPaths & { root: string }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), `tailscaled-${name}-`));
  const stateDir = path.join(root, 'state');
  const socketDir = path.join(root, 'run');
  const socket = path.join(socketDir, 'tailscaled.sock');
  return {
    root,
    stateDir,
    socketDir,
    socket,
    state: path.join(stateDir, 'tailscaled.state'),
    log: path.join(root, 'tailscaled.log'),
    binary: '/usr/local/bin/tailscaled',
  };
}

test('resolveTailscaledPaths uses classic entrypoint defaults and honors env overrides', () => {
  const defaults = resolveTailscaledPaths({});
  assert.equal(defaults.stateDir, '/data/tailscale');
  assert.equal(defaults.socketDir, '/data/run/tailscale');
  assert.equal(defaults.socket, '/data/run/tailscale/tailscaled.sock');
  assert.equal(defaults.state, '/data/tailscale/tailscaled.state');
  assert.equal(defaults.log, '/data/logs/tailscaled.log');
  assert.equal(defaults.binary, '/usr/local/bin/tailscaled');

  const overridden = resolveTailscaledPaths({
    TAILSCALE_STATE_DIR: '/tmp/state',
    TAILSCALE_SOCKET_DIR: '/tmp/run',
    TAILSCALE_LOG: '/tmp/tailscaled.log',
    TAILSCALE_BIN: '/opt/bin/tailscaled',
  });
  assert.equal(overridden.stateDir, '/tmp/state');
  assert.equal(overridden.socketDir, '/tmp/run');
  assert.equal(overridden.socket, '/tmp/run/tailscaled.sock');
  assert.equal(overridden.state, '/tmp/state/tailscaled.state');
  assert.equal(overridden.log, '/tmp/tailscaled.log');
  assert.equal(overridden.binary, '/opt/bin/tailscaled');
});

test('startTailscaledDaemon spawns userspace daemon and succeeds once the socket appears', async () => {
  const paths = await makePaths('ok');
  await fs.mkdir(paths.socketDir, { recursive: true });
  await fs.writeFile(paths.socket, 'stale');
  const { calls, spawn } = spawnRecorder();
  let listening: net.Server | undefined;

  try {
    const result = await startTailscaledDaemon({
      paths,
      spawn,
      timeoutMs: 2_000,
      pollMs: 20,
      uid: 1000,
      gid: 1000,
      afterSpawn: async () => {
        // Simulate tailscaled finishing its startup after the process is live.
        await new Promise((resolve) => setTimeout(resolve, 30));
        listening = net.createServer();
        await new Promise<void>((resolve, reject) => {
          listening!.once('error', reject);
          listening!.listen(paths.socket, () => resolve());
        });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.pid, 4242);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, '/usr/local/bin/tailscaled');
    assert.deepEqual(calls[0]!.args, [
      '--tun=userspace-networking',
      `--state=${paths.state}`,
      `--socket=${paths.socket}`,
    ]);
    assert.equal(calls[0]!.options.uid, 1000);
    assert.equal(calls[0]!.options.gid, 1000);
    assert.equal((calls[0]!.options.env as Record<string, string>).GOMEMLIMIT, '160MiB');
    assert.equal((calls[0]!.options.env as Record<string, string>).GOMAXPROCS, '1');
    const stale = await fs.readFile(paths.socket, 'utf8').catch(() => null);
    // The stale regular file must be removed before spawn; the fake socket
    // listener recreated the path as a real socket afterwards.
    assert.notEqual(stale, 'stale');
  } finally {
    await new Promise((resolve) => listening?.close(() => resolve(null)));
    await fs.rm(paths.root, { recursive: true, force: true });
  }
});

test('startTailscaledDaemon reports exited-before-socket when the child dies early', async () => {
  const paths = await makePaths('exit');
  const { child, calls, spawn } = spawnRecorder();

  const pending = startTailscaledDaemon({ paths, spawn, timeoutMs: 2_000, pollMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1);
  child.emit('exit', 1, null);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exited-before-socket');
  await fs.rm(paths.root, { recursive: true, force: true });
});

test('startTailscaledDaemon times out, reports timeout, and kills the child', async () => {
  const paths = await makePaths('timeout');
  const { child, spawn } = spawnRecorder();
  let killed: Array<NodeJS.Signals | number | undefined> = [];
  child.kill = (signal) => { killed.push(signal); return true; };

  const result = await startTailscaledDaemon({ paths, spawn, timeoutMs: 200, pollMs: 40 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.ok(killed.length > 0, 'child must be killed after timeout');
  await fs.rm(paths.root, { recursive: true, force: true });
});

test('startTailscaledDaemon reports spawn-error when the binary cannot start', async () => {
  const paths = await makePaths('spawn-error');
  const { child, spawn } = spawnRecorder();

  const pending = startTailscaledDaemon({ paths, spawn, timeoutMs: 2_000, pollMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  child.emit('error', new Error('ENOENT'));
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'spawn-error');
  await fs.rm(paths.root, { recursive: true, force: true });
});

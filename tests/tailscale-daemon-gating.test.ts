import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Environment must be in place before the service module is loaded: the
// Tailscale socket path is captured at import time and app-state lives under
// OPENCODE_TELEGRAM_HOME.
const home = await fs.mkdtemp(path.join(tmpdir(), 'tailscale-gating-'));
process.env.OPENCODE_TELEGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = 'test-token-fixture';
process.env.TELEGRAM_USER_ID = '12345';
const socketPath = path.join(home, 'tailscaled.sock');
process.env.TAILSCALE_SOCKET = socketPath;

const service = await import('../src/app/services/tailscale-integration-service.js');

test('configureTailscale saves the key without a daemon instead of failing', async () => {
  // Today (pre-fix) this rejects with "The shared tailscaled socket is
  // unavailable" because the local daemon path runs `tailscale up` first.
  await service.configureTailscale('tskey-auth-fixture-key');
  const state = JSON.parse(await fs.readFile(path.join(home, 'app-state.json'), 'utf8'));
  assert.equal(typeof state.integrations.tailscale.authKey.ciphertext, 'string');
  assert.equal(state.integrations.tailscale.authKey.version, 1);
});

test('initializeTailscaleIntegration validates the stored key when no daemon is running', async () => {
  assert.equal(await service.initializeTailscaleIntegration(), true);
});

test('status without a daemon reports topic-worker scope and stopped daemon', async () => {
  const status = await service.getTailscaleRuntimeStatus();
  assert.equal(status.configured, true);
  assert.equal(status.connected, false);
  assert.equal(status.daemonRunning, false);
  assert.equal(status.executionScope, 'topic-worker');
});

test('reconnect without a daemon rejects with the daemon-unavailable message', async () => {
  await assert.rejects(
    () => service.reconnectTailscale(),
    /shared tailscaled daemon is not running/u,
  );
});

test('status with a live daemon socket reports control-plane scope', async () => {
  const server = net.createServer();
  const connections = new Set<net.Socket>();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    const status = await service.getTailscaleRuntimeStatus();
    assert.equal(status.configured, true);
    assert.equal(status.daemonRunning, true);
    assert.equal(status.executionScope, 'control-plane');
  } finally {
    // The real `tailscale` CLI may hold a connection to the fake socket
    // server; close() alone would wait for it forever.
    for (const socket of connections) socket.destroy();
    server.close();
  }
});

test('removeTailscaleIntegration clears the stored key without a daemon', async () => {
  await service.removeTailscaleIntegration();
  const status = await service.getTailscaleRuntimeStatus();
  assert.equal(status.configured, false);
});

test('cleanup: temp home removed', async () => {
  await fs.rm(home, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path:string) => readFileSync(path,'utf8');

test('Railway worker policy is owned by Main Settings, not Railway env variables', () => {
  const menu = read('src/bot/menus/settings-menu.ts');
  const callback = read('src/bot/callbacks/settings-callback-handler.ts');
  const launcher = read('src/infrastructure/launcher.ts');
  const bootstrap = read('src/app/bootstrap/start-bot-app.ts');
  const index = read('src/index.ts');
  assert.match(menu, /🚂 Railway/);
  assert.match(menu, /SETTINGS_RAILWAY_CALLBACK/);
  assert.match(callback, /SETTINGS_RAILWAY_CALLBACK/);
  for (const source of [launcher, bootstrap, index]) {
    assert.doesNotMatch(source, /process\.env\.(?:CONTROL_CLUSTER_BOOTSTRAP_ENABLED|TOPIC_NODE_CREATION_ENABLED|WORKER_WARM_CAPACITY|WORKER_POOL_POLICY)/);
  }
});

test('Railway deployment credential contract uses exactly the intended Telegram user id name', () => {
  const config = read('src/config.ts');
  const bootstrap = read('src/runtime/bootstrap.ts');
  const example = read('.env.example');
  assert.match(config, /TELEGRAM_USER_ID/);
  assert.match(bootstrap, /TELEGRAM_USER_ID/);
  assert.match(example, /TELEGRAM_USER_ID=/);
  assert.doesNotMatch(config, /TELEGRAM_ALLOWED_USER_ID/);
  assert.doesNotMatch(bootstrap, /TELEGRAM_ALLOWED_USER_ID/);
  assert.doesNotMatch(example, /TELEGRAM_ALLOWED_USER_ID=/);
});

test('root IPC exposes persistent Railway worker settings get/update operations', () => {
  const transport = read('src/control-plane/application-transport.ts');
  const gateway = read('src/infrastructure/node-gateway.ts');
  assert.match(transport, /settings\.get/);
  assert.match(transport, /settings\.update/);
  assert.match(gateway, /settings\.get/);
  assert.match(gateway, /settings\.update/);
});

test('legacy Railway variables are reconciled after workspace verification, without requiring a Worker', () => {
  const launcher = read('src/infrastructure/launcher.ts');
  const configureStart = launcher.indexOf('const configureWorkspace=async');
  const cleanup = launcher.indexOf('cleanupDeprecatedControlVariables', configureStart);
  const workerVerify = launcher.indexOf('onClusterVerified', configureStart);
  assert.ok(configureStart >= 0 && cleanup > configureStart, 'workspace cleanup must exist');
  assert.ok(workerVerify < 0 || cleanup < workerVerify, 'cleanup must not wait for Worker verification');
});

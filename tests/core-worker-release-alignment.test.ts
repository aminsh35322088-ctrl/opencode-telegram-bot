import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {WORKER_CORE_COMMIT,WORKER_CORE_VERSION,WORKER_RUNTIME_IMAGE} from '../src/infrastructure/worker-core-release.js';

const lock=JSON.parse(readFileSync('core-release.lock.json','utf8')) as {telegramCoreVersion:string;telegramCoreCommit:string};

test('Railway Worker release stays aligned with the Bot Core compatibility unit',()=>{
  assert.equal(WORKER_CORE_VERSION,lock.telegramCoreVersion);
  assert.equal(WORKER_CORE_COMMIT,'e284c2fec18344260997bec5c0c2c60e49a620d4');
  assert.equal(WORKER_CORE_COMMIT,lock.telegramCoreCommit,'Worker runtime and compatibility package must share the verified Core source commit');
  assert.equal(WORKER_RUNTIME_IMAGE,'ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:bd8dce84a3ea1ae95fd39094826e39999a32b457f1e69e37376bf08c21a03629');
});

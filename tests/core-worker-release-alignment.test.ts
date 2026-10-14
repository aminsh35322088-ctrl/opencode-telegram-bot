import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {WORKER_CORE_COMMIT,WORKER_CORE_VERSION,WORKER_RUNTIME_IMAGE} from '../src/infrastructure/worker-core-release.js';

const lock=JSON.parse(readFileSync('core-release.lock.json','utf8')) as {telegramCoreVersion:string;telegramCoreCommit:string};

test('Railway Worker release stays aligned with the Bot Core compatibility unit',()=>{
  assert.equal(WORKER_CORE_VERSION,lock.telegramCoreVersion);
  assert.equal(WORKER_CORE_COMMIT,'6e19b05849ace61271d8fbc1adc14e7e8f85c297');
  assert.equal(WORKER_CORE_COMMIT,lock.telegramCoreCommit,'Worker runtime and compatibility package must share the verified Core source commit');
  assert.equal(WORKER_RUNTIME_IMAGE,'ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:2538ac4b78f0270bbe7226ac3174621065754de307be59eff46defbbc10dd095');
});

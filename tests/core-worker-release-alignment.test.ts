import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {WORKER_CORE_COMMIT,WORKER_CORE_VERSION,WORKER_RUNTIME_IMAGE} from '../src/infrastructure/worker-core-release.js';

const lock=JSON.parse(readFileSync('core-release.lock.json','utf8')) as {telegramCoreVersion:string;telegramCoreCommit:string};

test('Railway Worker release stays aligned with the Bot Core compatibility unit',()=>{
  assert.equal(WORKER_CORE_VERSION,lock.telegramCoreVersion);
  assert.equal(WORKER_CORE_COMMIT,'286312ed00945083fdf9da0eb2d004f6396cbd55');
  assert.notEqual(WORKER_CORE_COMMIT,lock.telegramCoreCommit,'Worker runtime advances independently from the compatibility package commit');
  assert.equal(WORKER_RUNTIME_IMAGE,'ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:a4c38c027e6ab7c7194b065936bfd1251b64a2f578c80756f44dc23b25057f12');
});

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {WORKER_CORE_COMMIT,WORKER_CORE_VERSION,WORKER_RUNTIME_IMAGE} from '../src/infrastructure/worker-core-release.js';

const lock=JSON.parse(readFileSync('core-release.lock.json','utf8')) as {telegramCoreVersion:string;telegramCoreCommit:string};

test('Railway Worker release stays aligned with the Bot Core compatibility unit',()=>{
  assert.equal(WORKER_CORE_VERSION,lock.telegramCoreVersion);
  assert.equal(WORKER_CORE_COMMIT,'385f1b70494ad4889d8532eda74afd426db79447');
  assert.equal(WORKER_CORE_COMMIT,lock.telegramCoreCommit,'Worker runtime and compatibility package must share the verified Core source commit');
  assert.equal(WORKER_RUNTIME_IMAGE,'ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:5e6b7b493f982aa3597fead7810f1ab32f1308c38bbdee9c4b6ec81b788026ea');
});

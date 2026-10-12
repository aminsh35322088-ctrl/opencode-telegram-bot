import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {WORKER_CORE_COMMIT,WORKER_CORE_VERSION,WORKER_RUNTIME_IMAGE} from '../src/infrastructure/worker-core-release.js';

const lock=JSON.parse(readFileSync('core-release.lock.json','utf8')) as {telegramCoreVersion:string;telegramCoreCommit:string};

test('Railway Worker release stays aligned with the Bot Core compatibility unit',()=>{
  assert.equal(WORKER_CORE_VERSION,lock.telegramCoreVersion);
  assert.equal(WORKER_CORE_COMMIT,'470b5c7e2d41ca4b6ae677b9ae461c757607aef4');
  assert.notEqual(WORKER_CORE_COMMIT,lock.telegramCoreCommit,'Worker runtime advances independently from the compatibility package commit');
  assert.equal(WORKER_RUNTIME_IMAGE,'ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:8920dcbceaee63d7350f6783f4299e04fb2bc35e43d857d05d18a9523baf822d');
});

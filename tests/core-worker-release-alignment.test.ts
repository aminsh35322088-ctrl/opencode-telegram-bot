import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {WORKER_CORE_COMMIT,WORKER_CORE_VERSION,WORKER_RUNTIME_IMAGE} from '../src/infrastructure/worker-core-release.js';

const lock=JSON.parse(readFileSync('core-release.lock.json','utf8')) as {
  repository:string;
  tag:string;
  telegramCoreVersion:string;
  telegramCoreCommit:string;
  assets:{sdk:{name:string};nativeRuntime:{name:string}};
};
const packageJson=JSON.parse(readFileSync('package.json','utf8')) as {dependencies:Record<string,string>};
const packageLock=JSON.parse(readFileSync('package-lock.json','utf8')) as {
  packages:Record<string,{dependencies?:Record<string,string>;resolved?:string;integrity?:string}>;
};

test('Railway Worker release stays aligned with the complete Bot Core compatibility unit',()=>{
  assert.match(lock.tag,/^v\d+\.\d+\.\d+-bot\.\d+-pre\.\d+$/);
  assert.equal(WORKER_CORE_VERSION,lock.telegramCoreVersion);
  assert.equal(WORKER_CORE_COMMIT,lock.telegramCoreCommit);
  assert.match(WORKER_CORE_COMMIT,/^[a-f0-9]{40}$/);
  assert.match(WORKER_RUNTIME_IMAGE,/^ghcr\.io\/aminsh35322088-ctrl\/opencode-telegram-worker@sha256:[a-f0-9]{64}$/);
  for(const [packageName,asset] of [
    ['@opencode-ai/sdk',lock.assets.sdk],
    ['@opencode-telegram/native-runtime',lock.assets.nativeRuntime],
  ] as const){
    const url=`https://github.com/${lock.repository}/releases/download/${lock.tag}/${asset.name}`;
    const entry=packageLock.packages[`node_modules/${packageName}`];
    assert.equal(packageJson.dependencies[packageName],url,`${packageName} package.json URL`);
    assert.equal(packageLock.packages[''].dependencies?.[packageName],url,`${packageName} root lock URL`);
    assert.equal(entry?.resolved,url,`${packageName} resolved lock URL`);
    assert.match(entry?.integrity??'',/^sha512-[A-Za-z0-9+/]+={0,2}$/,`${packageName} lock integrity`);
  }
});

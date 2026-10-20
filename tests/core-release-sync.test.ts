import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  assertPublishedReleaseAsset,
  compareCoreReleaseVersions,
  parseCoreReleaseVersion,
  parseVerifiedSourceCommit,
  selectLatestRelease,
} from '../scripts/sync-core-release.mjs';

// The updater exposes only pure metadata parsers; importing it never performs network I/O.
test('Core release versions compare numerically rather than lexicographically',()=>{
  assert.equal(compareCoreReleaseVersions('v1.18.33-bot.13-pre.40','v1.18.33-bot.13-pre.39'),1);
  assert.equal(compareCoreReleaseVersions('1.18.33-bot.13-pre.10','v1.18.33-bot.13-pre.9'),1);
  assert.equal(compareCoreReleaseVersions('v1.19.0-bot.1-pre.1','v1.18.99-bot.99-pre.99'),1);
  assert.equal(compareCoreReleaseVersions('v1.18.33-bot.13-pre.39','1.18.33-bot.13-pre.39'),0);
});

test('Core release candidate parser rejects tags outside the governed prerelease contract',()=>{
  assert.deepEqual(parseCoreReleaseVersion('v1.18.33-bot.13-pre.39'),{
    tag:'v1.18.33-bot.13-pre.39',
    version:'1.18.33-bot.13-pre.39',
    parts:[1,18,33,13,39],
  });
  assert.equal(parseCoreReleaseVersion('v1.18.33'),null);
  assert.equal(parseCoreReleaseVersion('latest'),null);
  assert.throws(()=>compareCoreReleaseVersions('v1.18.33','v1.18.32-bot.1-pre.1'));
});

test('release source is accepted only when notes record one full 40-character commit',()=>{
  const sha='8875dea402050848b53fd8d643e9322b6f5a68a0';
  assert.equal(parseVerifiedSourceCommit(`Verified release source: \`${sha}\`.`),sha);
  assert.throws(()=>parseVerifiedSourceCommit('release notes without source identity'));
  assert.throws(()=>parseVerifiedSourceCommit(`Verified release source: \`shortsha\`.`));
  assert.throws(()=>parseVerifiedSourceCommit([
    `Verified release source: \`${sha}\`.`,
    `Verified release source: \`${sha}\`.`,
  ].join('\n')));
});

test('newest release selection ignores drafts, stable tags and non-governed releases',()=>{
  const releases=[
    {tag_name:'v1.18.33-bot.13-pre.39',draft:false,prerelease:true},
    {tag_name:'v1.18.33-bot.13-pre.100',draft:false,prerelease:true},
    {tag_name:'v1.18.33-bot.14-pre.1',draft:false,prerelease:true},
    {tag_name:'v9.9.9-bot.99-pre.99',draft:true,prerelease:true},
    {tag_name:'v9.9.9',draft:false,prerelease:false},
    {tag_name:'v9.9.9-rc.1',draft:false,prerelease:true},
  ];
  assert.equal(selectLatestRelease(releases)?.tag_name,'v1.18.33-bot.14-pre.1');
  assert.equal(selectLatestRelease([]),undefined);
});

test('release assets must match GitHub published SHA-256 and exact byte size',()=>{
  const sha='a'.repeat(64);
  assert.equal(assertPublishedReleaseAsset('runtime.tgz',{sha256:sha,size:128},{digest:'sha256:'+sha,size:128}),true);
  assert.throws(()=>assertPublishedReleaseAsset('runtime.tgz',{sha256:'b'.repeat(64),size:128},{digest:'sha256:'+sha,size:128}),/published digest and size/);
  assert.throws(()=>assertPublishedReleaseAsset('runtime.tgz',{sha256:sha,size:127},{digest:'sha256:'+sha,size:128}),/published digest and size/);
  assert.throws(()=>assertPublishedReleaseAsset('runtime.tgz',{sha256:sha,size:128},{digest:'sha256:invalid',size:128}),/no trustworthy/);
});

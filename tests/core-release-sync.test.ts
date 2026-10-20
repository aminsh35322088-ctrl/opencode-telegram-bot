import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  compareCoreReleaseVersions,
  parseCoreReleaseVersion,
  parseVerifiedSourceCommit,
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

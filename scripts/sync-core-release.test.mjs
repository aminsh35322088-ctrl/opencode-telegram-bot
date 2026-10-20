import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareCoreReleaseVersions,
  parseCoreReleaseVersion,
  parseVerifiedSourceCommit,
  selectLatestRelease,
} from "./sync-core-release.mjs";

const commit = "a".repeat(40);

test("Core release tags accept only the project's governed prerelease format", () => {
  assert.deepEqual(parseCoreReleaseVersion("v1.18.33-bot.13-pre.39"), {
    tag: "v1.18.33-bot.13-pre.39",
    version: "1.18.33-bot.13-pre.39",
    parts: [1, 18, 33, 13, 39],
  });
  for (const invalid of ["latest", "v1.18.33", "v1.18.33-rc.1", "v1.18.33-bot.13-pre.latest", "../main"]) {
    assert.equal(parseCoreReleaseVersion(invalid), null, invalid);
  }
});

test("Core release versions compare numeric components rather than strings", () => {
  assert.equal(compareCoreReleaseVersions("v1.18.33-bot.13-pre.100", "v1.18.33-bot.13-pre.99"), 1);
  assert.equal(compareCoreReleaseVersions("v1.18.33-bot.14-pre.1", "v1.18.33-bot.13-pre.100"), 1);
  assert.equal(compareCoreReleaseVersions("v1.18.33-bot.13-pre.39", "1.18.33-bot.13-pre.39"), 0);
  assert.throws(() => compareCoreReleaseVersions("latest", "v1.18.33-bot.13-pre.39"));
});

test("Core release notes must carry exactly one full verified source commit", () => {
  assert.equal(parseVerifiedSourceCommit("Release notes.\nVerified release source: \`" + commit + "\`. \n"), commit);
  assert.throws(() => parseVerifiedSourceCommit("Verified release source: \`shortsha\`."));
  assert.throws(() => parseVerifiedSourceCommit("Verified release source: \`" + commit + "\`.\nVerified release source: \`" + commit + "\`."));
});

test("latest selection excludes drafts, stable releases, RCs, and non-governed tags", () => {
  const releases = [
    { tag_name: "v1.18.33-bot.13-pre.39", draft: false, prerelease: true },
    { tag_name: "v1.18.33-bot.13-pre.100", draft: false, prerelease: true },
    { tag_name: "v1.18.33-bot.14-pre.1", draft: false, prerelease: true },
    { tag_name: "v9.9.9-bot.99-pre.99", draft: true, prerelease: true },
    { tag_name: "v9.9.9", draft: false, prerelease: false },
    { tag_name: "v9.9.9-rc.1", draft: false, prerelease: true },
  ];
  assert.equal(selectLatestRelease(releases)?.tag_name, "v1.18.33-bot.14-pre.1");
  assert.equal(selectLatestRelease([]), undefined);
});

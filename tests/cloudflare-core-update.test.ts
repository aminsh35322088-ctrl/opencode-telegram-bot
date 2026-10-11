import assert from "node:assert/strict";
import test from "node:test";
import { discoverCoreUpdate, newerRelease } from "../src/cloudflare/core-update.js";

const current = { image: "old", commit: "a".repeat(40), version: "1.18.33-bot.13-pre.30" };
test("release order compares numeric revisions and never rolls backward", () => {
  assert.equal(newerRelease("1.18.33-bot.13-pre.100", current.version), true);
  assert.equal(newerRelease("1.18.33-bot.13-pre.9", current.version), false);
  assert.equal(newerRelease(current.version, current.version), false);
});
for (const failure of ["none", "digest", "upstream", "missing_image"] as const) {
  test(`Core discovery verifies release identity and immutable image: ${failure}`, async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const bytes = '{"schemaVersion":2,"manifests":[]}';
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes)))].map(b => b.toString(16).padStart(2, "0")).join("");
    const commit = "b".repeat(40);
    const asset = "https://github.com/aminsh35322088-ctrl/opencode-telegram-core/releases/download/v1.18.33-bot.13-pre.31/build-info.json";
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.includes("api.github.com")) return Response.json([{ draft: true, tag_name: "v1.18.33-bot.13-pre.32", assets: [] }, { draft: false, tag_name: "v1.18.33-bot.13-pre.31", assets: [{ name: "build-info.json", browser_download_url: asset }] }]);
      if (url === asset) return Response.json({ telegramCoreCommit: commit, telegramCoreVersion: "1.18.33-bot.13-pre.31", upstreamVersion: failure === "upstream" ? "1.19.0" : "1.18.33", runtimeProfile: "telegram-headless" });
      if (url.includes("/token?")) return Response.json({ token: "synthetic-public-pull-token" });
      assert.ok(url.endsWith("/manifests/" + commit));
      return new Response(bytes, { status: failure === "missing_image" ? 404 : 200, headers: { "docker-content-digest": "sha256:" + (failure === "digest" ? "0".repeat(64) : hash) } });
    };
    if (failure === "none") assert.deepEqual(await discoverCoreUpdate(current), { image: "ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:" + hash, commit, version: "1.18.33-bot.13-pre.31" });
    else await assert.rejects(discoverCoreUpdate(current), new RegExp(failure === "digest" ? "digest_mismatch" : failure === "upstream" ? "incompatible" : "not_published"));
  });
}

test("public release feed remains usable when GitHub REST is rate limited", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.includes("api.github.com")) return new Response("rate limited", { status: 403 });
    assert.ok(url.endsWith("/releases.atom"));
    return new Response('<feed><entry><link href="https://github.com/aminsh35322088-ctrl/opencode-telegram-core/releases/tag/v1.18.33-bot.13-pre.30"/></entry></feed>');
  };
  assert.equal(await discoverCoreUpdate(current), undefined);
  assert.equal(calls.length, 2);
});

import type { WorkerImageTarget } from "./worker-image-upgrade.js";

const repository = "aminsh35322088-ctrl/opencode-telegram-core";
const imageRepository = "aminsh35322088-ctrl/opencode-telegram-worker";
const headers = { "User-Agent": "OpenCode-Control-Plane", Accept: "application/vnd.github+json" };
async function json<T>(url: string, extra: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers: { ...headers, ...extra }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("core_release_unavailable_" + response.status);
  const body = await response.text();
  if (body.length > 512_000) throw new Error("core_release_response_too_large");
  return JSON.parse(body) as T;
}
export function releaseOrder(version: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)-bot\.(\d+)-pre\.(\d+)$/u.exec(version);
  if (!match) throw new Error("invalid_core_release_version");
  return match.slice(1).map(Number);
}
export function newerRelease(candidate: string, current: string): boolean {
  const left = releaseOrder(candidate), right = releaseOrder(current);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return false;
}
/** Follow published Core releases, including this project's prerelease channel.
 * Never switch to mutable latest: resolve and verify the content-addressed image.
 * Upstream changes need a matching Bot SDK release and remain an explicit migration.
 */
export async function discoverCoreUpdate(current: WorkerImageTarget): Promise<WorkerImageTarget | undefined> {
  type Release = { draft: boolean; tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
  let releases: Release[];
  try {
    releases = await json<Release[]>(`https://api.github.com/repos/${repository}/releases?per_page=20`);
  } catch {
    // Public release feeds avoid the shared unauthenticated REST API rate limit.
    const response = await fetch(`https://github.com/${repository}/releases.atom`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("core_release_feed_unavailable_" + response.status);
    const feed = await response.text();
    if (feed.length > 512_000) throw new Error("core_release_response_too_large");
    releases = [...feed.matchAll(/releases\/tag\/(v\d+\.\d+\.\d+-bot\.\d+-pre\.\d+)["<]/gu)].map(match => ({
      draft: false, tag_name: match[1]!, assets: [{ name: "build-info.json", browser_download_url: `https://github.com/${repository}/releases/download/${match[1]}/build-info.json` }],
    }));
    if (!releases.length) throw new Error("core_release_feed_invalid");
  }
  const release = releases.filter(r => !r.draft && /^v\d+\.\d+\.\d+-bot\.\d+-pre\.\d+$/u.test(r.tag_name))
    .sort((a, b) => newerRelease(a.tag_name.slice(1), b.tag_name.slice(1)) ? -1 : 1)[0];
  if (!release || !newerRelease(release.tag_name.slice(1), current.version)) return undefined;
  const expectedUrl = `https://github.com/${repository}/releases/download/${release.tag_name}/build-info.json`;
  if (!release.assets.some(asset => asset.name === "build-info.json" && asset.browser_download_url === expectedUrl))
    throw new Error("core_release_incomplete");
  const info = await json<{ telegramCoreVersion: string; telegramCoreCommit: string; runtimeProfile: string; upstreamVersion: string }>(expectedUrl);
  if (info.telegramCoreVersion !== release.tag_name.slice(1) || !/^[a-f0-9]{40}$/u.test(info.telegramCoreCommit) ||
      info.runtimeProfile !== "telegram-headless" || info.upstreamVersion !== current.version.split("-bot.")[0])
    throw new Error("core_release_incompatible");
  const auth = await json<{ token: string }>(`https://ghcr.io/token?service=ghcr.io&scope=repository:${imageRepository}:pull`);
  const response = await fetch(`https://ghcr.io/v2/${imageRepository}/manifests/${info.telegramCoreCommit}`, {
    headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("core_image_not_published");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 512_000) throw new Error("core_image_response_too_large");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
  const digest = "sha256:" + hash;
  if (response.headers.get("docker-content-digest") !== digest) throw new Error("core_image_digest_mismatch");
  return { image: `ghcr.io/${imageRepository}@${digest}`, commit: info.telegramCoreCommit, version: info.telegramCoreVersion };
}

import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const CORE_REPOSITORY = "aminsh35322088-ctrl/opencode-telegram-core";
const WORKER_IMAGE_REPOSITORY = "aminsh35322088-ctrl/opencode-telegram-worker";
const REGISTRY = "https://ghcr.io";
const GITHUB_API = "https://api.github.com";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "core-release.lock.json");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const WORKER_RELEASE_PATH = path.join(ROOT, "src/infrastructure/worker-core-release.ts");
const ASSET_NAMES = {
  runtime: "opencode-telegram-core-linux-x64.tar.gz",
  sdk: "opencode-telegram-core-sdk-node.tar.gz",
  nativeRuntime: "opencode-telegram-native-runtime-node.tar.gz",
};
const PACKAGE_NAMES = {
  sdk: "@opencode-ai/sdk",
  nativeRuntime: "@opencode-telegram/native-runtime",
};
const MAX_ASSET_BYTES = {
  runtime: 250 * 1024 * 1024,
  sdk: 150 * 1024 * 1024,
  nativeRuntime: 150 * 1024 * 1024,
};
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export function parseCoreReleaseVersion(tag) {
  if (typeof tag !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)-bot\.(\d+)-pre\.(\d+)$/.exec(tag);
  if (!match) return null;
  return {
    tag: `v${tag.replace(/^v/, "")}`,
    version: tag.replace(/^v/, ""),
    parts: match.slice(1).map(Number),
  };
}

export function compareCoreReleaseVersions(left, right) {
  const a = parseCoreReleaseVersion(left);
  const b = parseCoreReleaseVersion(right);
  if (!a || !b) throw new Error("Only governed Core prerelease tags can be compared");
  for (let index = 0; index < a.parts.length; index += 1) {
    const difference = a.parts[index] - b.parts[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function parseVerifiedSourceCommit(body) {
  if (typeof body !== "string") throw new Error("Core release notes are missing");
  const matches = [...body.matchAll(/Verified release source:\s+`([a-f0-9]{40})`\./g)];
  if (matches.length !== 1) throw new Error("Core release must identify exactly one verified source commit");
  return matches[0][1];
}

function requireFullCommit(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`${label} is not a full Git commit SHA`);
  }
  return value;
}

async function requestJson(url, { headers = {}, redirect = "error" } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opencode-telegram-core-release-sync",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      ...headers,
    },
    redirect,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Trusted release metadata request failed (HTTP ${response.status})`);
  return response.json();
}

async function readBoundedBytes(response, limit, label) {
  if (!response.ok) throw new Error(`${label} download failed (HTTP ${response.status})`);
  if (!response.body) throw new Error(`${label} response has no body`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      await response.body.cancel().catch(() => {});
      throw new Error(`${label} exceeded the permitted download size`);
    }
    chunks.push(bytes);
  }
  if (size === 0) throw new Error(`${label} response was empty`);
  return Buffer.concat(chunks, size);
}

function digest(bytes, algorithm, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function fetchReleaseAsset(tag, name, maxBytes) {
  const url = `https://github.com/${CORE_REPOSITORY}/releases/download/${tag}/${name}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "opencode-telegram-core-release-sync" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  const bytes = await readBoundedBytes(response, maxBytes, name);
  return {
    name,
    size: bytes.length,
    sha256: digest(bytes, "sha256"),
    integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
  };
}

async function resolveTagCommit(tag) {
  const ref = await requestJson(`${GITHUB_API}/repos/${CORE_REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref.object;
  for (let depth = 0; depth < 5; depth += 1) {
    if (object?.type === "commit") return requireFullCommit(object.sha, "Resolved Core tag");
    if (object?.type !== "tag" || typeof object.sha !== "string") break;
    const annotated = await requestJson(`${GITHUB_API}/repos/${CORE_REPOSITORY}/git/tags/${object.sha}`);
    object = annotated.object;
  }
  throw new Error("Core release tag did not resolve to a commit");
}

async function readUpstreamLock(tag) {
  const url = `https://raw.githubusercontent.com/${CORE_REPOSITORY}/${tag}/upstream/lock.json`;
  const response = await fetch(url, {
    headers: { "User-Agent": "opencode-telegram-core-release-sync" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Core source lock unavailable for ${tag} (HTTP ${response.status})`);
  const value = await response.json();
  if (
    value?.telegramCoreVersion !== tag.replace(/^v/, "") ||
    typeof value.version !== "string" ||
    typeof value.commit !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version)
  ) {
    throw new Error("Core source lock does not match its release tag");
  }
  requireFullCommit(value.commit, "Pinned upstream commit");
  return value;
}

async function getRegistryToken() {
  const url = `${REGISTRY}/token?scope=repository:${WORKER_IMAGE_REPOSITORY}:pull`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Worker registry authentication failed (HTTP ${response.status})`);
  const value = await response.json();
  const token = value.token ?? value.access_token;
  if (typeof token !== "string" || token.length < 20) throw new Error("Worker registry did not issue a pull token");
  return token;
}

async function fetchWorkerManifest(reference, token) {
  const referencePath = /^sha256:[a-f0-9]{64}$/.test(reference) ? reference : encodeURIComponent(reference);
  const response = await fetch(
    REGISTRY + "/v2/" + WORKER_IMAGE_REPOSITORY + "/manifests/" + referencePath,
    {
      headers: { Authorization: "Bearer " + token, Accept: MANIFEST_ACCEPT },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error("Worker image manifest unavailable for verified Core commit (HTTP " + response.status + ")");
  const imageDigest = response.headers.get("docker-content-digest");
  if (typeof imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    throw new Error("Worker registry did not return an immutable SHA-256 manifest digest");
  }
  if (/^sha256:[a-f0-9]{64}$/.test(reference) && imageDigest !== reference) {
    throw new Error("Worker registry returned a manifest different from the requested digest");
  }
  const body = await readBoundedBytes(response, 8 * 1024 * 1024, "Worker image manifest");
  if (digest(body, "sha256") !== imageDigest.slice("sha256:".length)) {
    throw new Error("Worker registry manifest failed its content digest");
  }
  return { digest: imageDigest, manifest: JSON.parse(body.toString("utf8")) };
}

async function verifyWorkerImage(sourceCommit) {
  const token = await getRegistryToken();
  const root = await fetchWorkerManifest(sourceCommit, token);
  let platformManifest = root.manifest;

  if (Array.isArray(root.manifest?.manifests)) {
    const matches = root.manifest.manifests.filter(
      (item) => item.platform?.os === "linux" && item.platform?.architecture === "amd64",
    );
    if (matches.length !== 1 || typeof matches[0]?.digest !== "string") {
      throw new Error("Worker image index must contain exactly one linux/amd64 image");
    }
    platformManifest = (await fetchWorkerManifest(matches[0].digest, token)).manifest;
  }

  const configDigest = platformManifest?.config?.digest;
  if (typeof configDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(configDigest)) {
    throw new Error("Worker image manifest has no valid config digest");
  }
  const configResponse = await fetch(
    REGISTRY + "/v2/" + WORKER_IMAGE_REPOSITORY + "/blobs/" + configDigest,
    {
      headers: { Authorization: "Bearer " + token },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const configBytes = await readBoundedBytes(configResponse, 8 * 1024 * 1024, "Worker image config");
  if (digest(configBytes, "sha256") !== configDigest.slice("sha256:".length)) {
    throw new Error("Worker image configuration failed its content digest");
  }
  const imageConfig = JSON.parse(configBytes.toString("utf8"));
  const labels = imageConfig.config?.Labels ?? imageConfig.config?.labels ?? {};
  if (labels["org.opencontainers.image.revision"] !== sourceCommit) {
    throw new Error("Worker image source label does not match the verified Core release commit");
  }
  return REGISTRY + "/" + WORKER_IMAGE_REPOSITORY + "@" + root.digest;
}

export function selectLatestRelease(releases) {
  return releases
    .filter((release) => release && release.draft === false && release.prerelease === true && parseCoreReleaseVersion(release.tag_name))
    .sort((left, right) => compareCoreReleaseVersions(right.tag_name, left.tag_name))[0];
}

function writeGitHubOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return Promise.resolve();
  const content = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  return appendFile(process.env.GITHUB_OUTPUT, content, "utf8");
}

async function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, "utf8");
}

async function syncRelease() {
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
  const packageJson = JSON.parse(await readFile(PACKAGE_PATH, "utf8"));
  const releases = await requestJson(`${GITHUB_API}/repos/${CORE_REPOSITORY}/releases?per_page=100`);
  if (!Array.isArray(releases)) throw new Error("GitHub did not return the Core releases list");

  const latest = selectLatestRelease(releases);
  const latestVersion = latest && parseCoreReleaseVersion(latest.tag_name);
  const currentVersion = parseCoreReleaseVersion(lock.tag);
  if (!latest || !latestVersion || !currentVersion) throw new Error("No governed Core prerelease was found");
  if (compareCoreReleaseVersions(latest.tag_name, lock.tag) <= 0) {
    console.log(`Core pin is current: ${lock.tag}`);
    await writeGitHubOutput({ changed: "false", version: lock.telegramCoreVersion });
    await writeSummary(["## Core release sync", `- Pinned Core: ${lock.tag}`, "- Result: already current; no files changed."]);
    return;
  }

  const sourceCommit = parseVerifiedSourceCommit(latest.body);
  if (/^[a-f0-9]{40}$/.test(latest.target_commitish ?? "") && latest.target_commitish !== sourceCommit) {
    throw new Error("Core release target does not match the release's verified source commit");
  }
  const taggedCommit = await resolveTagCommit(latest.tag_name);
  if (taggedCommit !== sourceCommit) throw new Error("Core release tag and verified release source commit differ");
  const upstream = await readUpstreamLock(latest.tag_name);
  if (upstream.telegramCoreVersion !== latestVersion.version) throw new Error("Core source metadata/version mismatch");

  const image = await verifyWorkerImage(sourceCommit);
  const releaseAssets = new Map(
    (Array.isArray(latest.assets) ? latest.assets : []).map((asset) => [asset.name, asset]),
  );
  const assets = {};
  for (const [key, name] of Object.entries(ASSET_NAMES)) {
    const expected = releaseAssets.get(name);
    if (
      !expected ||
      typeof expected.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(expected.digest) ||
      !Number.isSafeInteger(expected.size) ||
      expected.size <= 0
    ) {
      throw new Error(`Core release API has no trustworthy SHA-256/size metadata for ${name}`);
    }
    const actual = await fetchReleaseAsset(latest.tag_name, name, MAX_ASSET_BYTES[key]);
    if (actual.sha256 !== expected.digest.slice("sha256:".length) || actual.size !== expected.size) {
      throw new Error(`Core release asset does not match GitHub's published digest and size: ${name}`);
    }
    assets[key] = actual;
  }

  const nextLock = {
    ...lock,
    tag: latestVersion.tag,
    telegramCoreVersion: latestVersion.version,
    telegramCoreCommit: sourceCommit,
    upstreamVersion: upstream.version,
    upstreamCommit: upstream.commit,
    assets: {
      ...lock.assets,
      runtime: { name: ASSET_NAMES.runtime, sha256: assets.runtime.sha256 },
      sdk: { name: ASSET_NAMES.sdk, sha256: assets.sdk.sha256 },
      nativeRuntime: { name: ASSET_NAMES.nativeRuntime, sha256: assets.nativeRuntime.sha256 },
    },
  };

  for (const key of ["sdk", "nativeRuntime"]) {
    const name = PACKAGE_NAMES[key];
    packageJson.dependencies[name] = `https://github.com/${CORE_REPOSITORY}/releases/download/${latestVersion.tag}/${ASSET_NAMES[key]}`;
  }

  // Write the complete pin only after the release, tag, assets, registry digest,
  // and the image's embedded source revision have all been verified.
  await writeFile(LOCK_PATH, `${JSON.stringify(nextLock, null, 2)}\n`);
  await writeFile(PACKAGE_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(
    WORKER_RELEASE_PATH,
    [
      "/** Verified immutable Worker runtime compatible with the Bot Core compatibility unit. */",
      `export const WORKER_CORE_COMMIT="${sourceCommit}";`,
      `export const WORKER_CORE_VERSION="${latestVersion.version}";`,
      `export const WORKER_RUNTIME_IMAGE="${image}";`,
      "",
    ].join("\n"),
  );

  // npm updates the dependency graph and lockfile from the exact release tarballs.
  // Scripts are disabled because this step only resolves metadata; CI installs and
  // runs the actual package scripts after the new lockfile is generated.
  await execFileAsync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress"],
    { cwd: ROOT, env: process.env, maxBuffer: 8 * 1024 * 1024 },
  );

  const packageLock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));
  for (const key of ["sdk", "nativeRuntime"]) {
    const name = PACKAGE_NAMES[key];
    const url = `https://github.com/${CORE_REPOSITORY}/releases/download/${latestVersion.tag}/${ASSET_NAMES[key]}`;
    const entry = packageLock.packages?.[`node_modules/${name}`];
    if (
      packageJson.dependencies?.[name] !== url ||
      packageLock.packages?.[""]?.dependencies?.[name] !== url ||
      entry?.resolved !== url ||
      entry?.integrity !== assets[key].integrity
    ) {
      throw new Error(`Generated npm lockfile is not aligned with the verified Core ${key} asset`);
    }
  }

  console.log(`Verified Core update: ${lock.tag} -> ${latestVersion.tag} (${sourceCommit})`);
  await writeGitHubOutput({ changed: "true", version: latestVersion.version, tag: latestVersion.tag, commit: sourceCommit });
  await writeSummary([
    "## Core release sync",
    `- Previous pin: ${lock.tag}`,
    `- Verified release: ${latestVersion.tag}`,
    `- Core source: ${sourceCommit}`,
    `- Worker image: ${image}`,
    "- Runtime, SDK, and native-runtime bytes match GitHub's published SHA-256 and size; npm SHA-512 integrity and immutable Worker digest verified.",
    "- Proceeding to the complete Bot test gate before updating main.",
  ]);
}

async function main() {
  await syncRelease();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Core release sync failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

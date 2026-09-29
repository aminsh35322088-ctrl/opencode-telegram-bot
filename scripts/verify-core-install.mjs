import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(root, "core-release.lock.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const sdkInfo = JSON.parse(
  await readFile(path.join(root, "node_modules/@opencode-ai/sdk/sdk-info.json"), "utf8"),
);
const nativeInfo = JSON.parse(
  await readFile(path.join(root, "node_modules/@opencode-telegram/native-runtime/runtime-info.json"), "utf8"),
);

function requireEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}
for (const [name, info] of [["SDK", sdkInfo], ["native runtime", nativeInfo]]) {
  requireEqual(`${name} Core commit`, info.telegramCoreCommit, lock.telegramCoreCommit);
  requireEqual(`${name} upstream version`, info.upstreamVersion, lock.upstreamVersion);
  requireEqual(`${name} upstream commit`, info.upstreamCommit, lock.upstreamCommit);
}
requireEqual("native consumer runtime", nativeInfo.consumerRuntime, "node");

const sdkDependency = packageJson.dependencies?.["@opencode-ai/sdk"];
const nativeDependency = packageJson.dependencies?.["@opencode-telegram/native-runtime"];
for (const [label, dependency, asset] of [
  ["SDK", sdkDependency, lock.assets.sdk],
  ["native runtime", nativeDependency, lock.assets.nativeRuntime],
]) {
  if (typeof dependency !== "string" || !dependency.includes(`/${lock.tag}/${asset.name}`)) {
    throw new Error(`${label} dependency is not pinned to the locked Core release asset`);
  }
}

if (process.argv.includes("--runtime")) {
  const binary = path.join(root, ".core/bin/opencode");
  const version = (await execFileAsync(binary, ["--version"])).stdout.trim();
  requireEqual("Core runtime upstream version", version, lock.upstreamVersion);
  const buildInfo = JSON.parse(
    (await execFileAsync(binary, ["debug", "build-info"])).stdout,
  );
  requireEqual("runtime Core version", buildInfo.telegramCoreVersion, lock.telegramCoreVersion);
  requireEqual("runtime Core commit", buildInfo.telegramCoreCommit, lock.telegramCoreCommit);
  requireEqual("runtime upstream commit", buildInfo.upstreamCommit, lock.upstreamCommit);
  requireEqual("runtime SDK revision", buildInfo.sdkRevision, lock.upstreamCommit);
}

console.log(
  `Verified OpenCode Telegram Core ${lock.telegramCoreVersion} / OpenCode ${lock.upstreamVersion}`,
);

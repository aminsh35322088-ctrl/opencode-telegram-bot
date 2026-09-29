import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(root, "core-release.lock.json"), "utf8"));
const out = path.join(root, ".core");
const bin = path.join(out, "bin");
const asset = lock.assets.runtime;
const archive = path.join(out, asset.name);

function assetUrl(name) {
  return `https://github.com/${lock.repository}/releases/download/${lock.tag}/${name}`;
}

const response = await fetch(assetUrl(asset.name), { redirect: "follow" });
if (!response.ok) {
  throw new Error(`Core runtime download failed: ${response.status} ${response.statusText}`);
}
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== asset.sha256) {
  throw new Error(`Core runtime checksum mismatch: expected ${asset.sha256}, got ${digest}`);
}

await mkdir(out, { recursive: true });
await writeFile(archive, bytes);
await rm(bin, { recursive: true, force: true });
await mkdir(bin, { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn("tar", ["-xzf", archive, "-C", bin], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)));
});
await chmod(path.join(bin, "opencode"), 0o755);
await rm(archive, { force: true });
await writeFile(path.join(out, "release.json"), JSON.stringify(lock, null, 2) + "\n");

console.log(
  `Materialized OpenCode Telegram Core runtime ${lock.telegramCoreVersion} (${lock.telegramCoreCommit.slice(0, 12)})`,
);

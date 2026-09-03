import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import packageJson from "../../../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const OPENCODE_VERSION_FILE = "/app/.opencode-version";
const RELEASE_NOTES_DIR = "/app/docs/release-notes";
const BOT_VERSION_NOTIFIED_FILE = "/data/.last-bot-version-notified";

export const BOT_VERSION = packageJson.version;

interface VersionEntry {
  name: string;
  version: string;
  kind: "core" | "dependency" | "tool" | "runtime";
}

interface VersionCommand {
  name: string;
  command: string;
  args: string[];
  kind: VersionEntry["kind"];
}

const VERSION_COMMANDS: VersionCommand[] = [
  { name: "npm", command: "npm", args: ["--version"], kind: "runtime" },
  { name: "Git", command: "git", args: ["--version"], kind: "tool" },
  { name: "Git LFS", command: "git", args: ["lfs", "version"], kind: "tool" },
  { name: "GitHub CLI", command: "gh", args: ["--version"], kind: "tool" },
  { name: "Railway CLI", command: "railway", args: ["--version"], kind: "tool" },
  { name: "Playwright CLI", command: "playwright-cli", args: ["--version"], kind: "tool" },
  { name: "pnpm", command: "pnpm", args: ["--version"], kind: "tool" },
  { name: "tsx", command: "tsx", args: ["--version"], kind: "tool" },
  { name: "TypeScript", command: "tsc", args: ["--version"], kind: "tool" },
  { name: "ESLint", command: "eslint", args: ["--version"], kind: "tool" },
  { name: "Vitest", command: "vitest", args: ["--version"], kind: "tool" },
  { name: "Python", command: "python3", args: ["--version"], kind: "runtime" },
  { name: "pytest", command: "pytest", args: ["--version"], kind: "tool" },
  { name: "curl", command: "curl", args: ["--version"], kind: "tool" },
  { name: "wget", command: "wget", args: ["--version"], kind: "tool" },
  { name: "jq", command: "jq", args: ["--version"], kind: "tool" },
  { name: "ripgrep", command: "rg", args: ["--version"], kind: "tool" },
  { name: "fd", command: "fdfind", args: ["--version"], kind: "tool" },
  { name: "tree", command: "tree", args: ["--version"], kind: "tool" },
  { name: "SQLite", command: "sqlite3", args: ["--version"], kind: "tool" },
  { name: "FFmpeg", command: "ffmpeg", args: ["-version"], kind: "tool" },
  { name: "ImageMagick", command: "convert", args: ["-version"], kind: "tool" },
];

function firstLine(value: string): string {
  return value.split("\n", 1)[0]?.trim() ?? value.trim();
}

function extractVersion(value: string): string {
  const line = firstLine(value).replace(/^v(?=\d)/i, "");
  const match = line.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0] ?? line || "unknown";
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function commandVersion(command: VersionCommand): Promise<VersionEntry | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command.command, command.args, {
      timeout: 3000,
      windowsHide: true,
    });
    const output = stdout.trim() || stderr.trim();
    if (!output) return null;
    return { name: command.name, version: extractVersion(output), kind: command.kind };
  } catch {
    return null;
  }
}

async function dependencyVersions(): Promise<VersionEntry[]> {
  const dependencies = packageJson.dependencies ?? {};
  const entries: VersionEntry[] = [];

  for (const name of Object.keys(dependencies)) {
    try {
      const metadata = JSON.parse(await readFile(`/app/node_modules/${name}/package.json`, "utf8")) as { version?: unknown };
      if (typeof metadata.version === "string") entries.push({ name, version: metadata.version, kind: "dependency" });
    } catch {
      entries.push({ name, version: "not installed", kind: "dependency" });
    }
  }

  return entries;
}

export async function getOpenCodeVersion(): Promise<string> {
  return (await readTextFile(OPENCODE_VERSION_FILE)) ?? "unknown";
}

export interface VersionSnapshot {
  botVersion: string;
  openCodeVersion: string;
  nodeVersion: string;
  entries: VersionEntry[];
}

export async function getVersionSnapshot(): Promise<VersionSnapshot> {
  const [openCodeVersion, dependencies, tools] = await Promise.all([
    getOpenCodeVersion(),
    dependencyVersions(),
    Promise.all(VERSION_COMMANDS.map(commandVersion)),
  ]);

  const runtimeEntries: VersionEntry[] = [
    { name: "Node.js", version: process.version.replace(/^v/, ""), kind: "runtime" },
    ...tools.filter((entry): entry is VersionEntry => entry !== null),
  ];

  return {
    botVersion: BOT_VERSION,
    openCodeVersion,
    nodeVersion: process.version.replace(/^v/, ""),
    entries: [
      { name: "OpenCode", version: openCodeVersion, kind: "core" },
      ...runtimeEntries,
      ...dependencies,
    ],
  };
}

export async function getCurrentReleaseChangelog(): Promise<string | null> {
  return readTextFile(`${RELEASE_NOTES_DIR}/v${BOT_VERSION}.md`);
}

export async function getBotUpdateNotice(): Promise<{ previousVersion: string; currentVersion: string; changelog: string | null } | null> {
  const previousVersion = await readTextFile(BOT_VERSION_NOTIFIED_FILE);
  if (!previousVersion) {
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(BOT_VERSION_NOTIFIED_FILE, `${BOT_VERSION}\n`, "utf8");
    } catch {
      // Notification state is best-effort; the command itself remains usable.
    }
    return null;
  }

  if (previousVersion === BOT_VERSION) return null;

  const changelog = await getCurrentReleaseChangelog();
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(BOT_VERSION_NOTIFIED_FILE, `${BOT_VERSION}\n`, "utf8");
  } catch {
    // A failed state write may cause a repeat notification on a later command.
  }

  return { previousVersion, currentVersion: BOT_VERSION, changelog };
}

export function formatVersionSnapshot(snapshot: VersionSnapshot): string {
  const core = snapshot.entries.filter((entry) => entry.kind === "core");
  const runtime = snapshot.entries.filter((entry) => entry.kind === "runtime");
  const tools = snapshot.entries.filter((entry) => entry.kind === "tool");
  const dependencies = snapshot.entries.filter((entry) => entry.kind === "dependency");

  const section = (title: string, entries: VersionEntry[]): string[] => {
    if (entries.length === 0) return [];
    return [title, ...entries.map((entry) => `• ${entry.name}: ${entry.version}`), ""];
  };

  return [
    "🧰 <b>All Version Info</b>",
    "",
    ...section("🤖 Core", [{ name: "Telegram Bot", version: snapshot.botVersion, kind: "core" }, ...core]),
    ...section("🖥️ Runtime", runtime),
    ...section("🛠️ Integrated Tools", tools),
    ...section("📦 Runtime Dependencies", dependencies),
  ].join("\n").trim();
}

export async function formatCurrentVersionSummary(): Promise<string> {
  const snapshot = await getVersionSnapshot();
  return [
    `🤖 Bot <b>v${snapshot.botVersion}</b>`,
    `🧠 OpenCode <b>v${snapshot.openCodeVersion}</b>`,
    `🟢 Node.js <b>v${snapshot.nodeVersion}</b>`,
  ].join("\n");
}

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CoreReleaseInfo {
  schemaVersion: number;
  repository: string;
  tag: string;
  telegramCoreVersion: string;
  telegramCoreCommit: string;
  upstreamVersion: string;
  upstreamCommit: string;
}

let cached: Promise<CoreReleaseInfo> | null = null;

function parseCoreReleaseInfo(value: unknown): CoreReleaseInfo {
  if (!value || typeof value !== "object") throw new Error("Core release lock must be an object");
  const record = value as Record<string, unknown>;
  for (const key of [
    "repository", "tag", "telegramCoreVersion", "telegramCoreCommit",
    "upstreamVersion", "upstreamCommit",
  ]) {
    if (typeof record[key] !== "string" || !record[key]) {
      throw new Error(`Invalid Core release field: ${key}`);
    }
  }
  return {
    schemaVersion: Number(record.schemaVersion ?? 1),
    repository: record.repository as string,
    tag: record.tag as string,
    telegramCoreVersion: record.telegramCoreVersion as string,
    telegramCoreCommit: record.telegramCoreCommit as string,
    upstreamVersion: record.upstreamVersion as string,
    upstreamCommit: record.upstreamCommit as string,
  };
}

async function loadCoreReleaseInfo(): Promise<CoreReleaseInfo> {
  const candidates = [
    path.resolve(process.cwd(), ".core", "release.json"),
    path.resolve(process.cwd(), "core-release.lock.json"),
    "/app/.core/release.json",
    "/app/core-release.lock.json",
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return parseCoreReleaseInfo(JSON.parse(await readFile(candidate, "utf8")));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("OpenCode Telegram Core release identity is unavailable", { cause: lastError });
}

export function getCoreReleaseInfo(): Promise<CoreReleaseInfo> {
  cached ??= loadCoreReleaseInfo();
  return cached;
}

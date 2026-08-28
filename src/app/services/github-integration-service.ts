import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

const INTEGRATIONS_DIR = "integrations";
const GITHUB_TOKEN_FILENAME = "github.token";

function getTokenPath(): string {
  return path.join(getRuntimePaths().appHome, INTEGRATIONS_DIR, GITHUB_TOKEN_FILENAME);
}

function normalizeToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("GitHub token is empty");
  if (token.length > 1024) throw new Error("GitHub token is too long");
  return token;
}

export async function getGithubToken(): Promise<string> {
  try {
    return (await fs.readFile(getTokenPath(), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function hasGithubToken(): Promise<boolean> {
  return Boolean(await getGithubToken());
}

export async function saveGithubToken(value: string): Promise<void> {
  const token = normalizeToken(value);
  const tokenPath = getTokenPath();
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  process.env.GITHUB_TOKEN = token;
}

export async function clearGithubToken(): Promise<void> {
  await fs.rm(getTokenPath(), { force: true });
  delete process.env.GITHUB_TOKEN;
}

export async function initializeGithubTokenFromEnvironment(): Promise<boolean> {
  const existing = await getGithubToken();
  if (existing) {
    process.env.GITHUB_TOKEN = existing;
    return true;
  }

  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (!envToken) return false;

  await saveGithubToken(envToken);
  return true;
}

export function getGithubTokenPath(): string {
  return getTokenPath();
}

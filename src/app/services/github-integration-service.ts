import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

const INTEGRATIONS_DIR = "integrations";
const GITHUB_DIR = "github";
const LEGACY_GITHUB_TOKEN_FILENAME = "github.token";
const INDEX_FILENAME = "accounts.json";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GithubAccount {
  id: string;
  name: string;
  username: string | undefined;
  tokenFile: string;
  createdAt: string;
}

interface GithubIndex {
  activeId: string | undefined;
  accounts: GithubAccount[];
}

export interface GithubTokenValidation {
  valid: boolean;
  username?: string;
  reason?: "missing" | "unauthorized" | "forbidden" | "network" | "invalid_response";
}

function getGithubDir(): string {
  return path.join(getRuntimePaths().appHome, INTEGRATIONS_DIR, GITHUB_DIR);
}

function getIndexPath(): string {
  return path.join(getGithubDir(), INDEX_FILENAME);
}

function getLegacyTokenPath(): string {
  return path.join(getRuntimePaths().appHome, INTEGRATIONS_DIR, LEGACY_GITHUB_TOKEN_FILENAME);
}

function getAccountTokenPath(account: GithubAccount): string {
  return path.join(getGithubDir(), account.tokenFile);
}

function normalizeToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("GitHub token is empty");
  if (token.length > 1024) throw new Error("GitHub token is too long");
  return token;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return slug || "github";
}

async function readIndex(): Promise<GithubIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(getIndexPath(), "utf8")) as Partial<GithubIndex>;
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [], activeId: undefined };
    throw error;
  }
}

async function writeIndex(index: GithubIndex): Promise<void> {
  await fs.mkdir(getGithubDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(getIndexPath(), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
}

async function applyActiveToken(index: GithubIndex): Promise<string> {
  const active = index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0];
  if (!active) {
    delete process.env.GITHUB_TOKEN;
    return "";
  }
  const token = (await fs.readFile(getAccountTokenPath(active), "utf8")).trim();
  process.env.GITHUB_TOKEN = token;
  return token;
}

export async function validateGithubToken(tokenValue: string): Promise<GithubTokenValidation> {
  const token = tokenValue.trim();
  if (!token) return { valid: false, reason: "missing" };

  try {
    const response = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401) return { valid: false, reason: "unauthorized" };
    if (response.status === 403) return { valid: false, reason: "forbidden" };
    if (!response.ok) return { valid: false, reason: "invalid_response" };

    const payload = (await response.json()) as { login?: unknown };
    if (typeof payload.login !== "string" || !payload.login.trim()) {
      return { valid: false, reason: "invalid_response" };
    }

    return { valid: true, username: payload.login };
  } catch {
    return { valid: false, reason: "network" };
  }
}

export async function listGithubAccounts(): Promise<GithubAccount[]> {
  return (await readIndex()).accounts;
}

export async function getActiveGithubAccount(): Promise<GithubAccount | null> {
  const index = await readIndex();
  return index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0] ?? null;
}

export async function addGithubAccount(name: string, tokenValue: string, username?: string): Promise<GithubAccount> {
  const token = normalizeToken(tokenValue);
  const cleanName = name.trim();
  if (!cleanName) throw new Error("GitHub account name is empty");

  const validation = await validateGithubToken(token);
  if (!validation.valid) {
    const reason = validation.reason === "unauthorized" ? "GitHub rejected this token (unauthorized)." :
      validation.reason === "forbidden" ? "GitHub rejected this token (forbidden)." :
      validation.reason === "network" ? "Could not reach the GitHub API to verify this token." :
      "GitHub returned an invalid token response.";
    throw new Error(`${reason} The token was not saved.`);
  }

  const index = await readIndex();
  const base = slugify(cleanName);
  let id = base;
  let counter = 2;
  while (index.accounts.some((account) => account.id === id)) id = `${base}-${counter++}`;

  const account: GithubAccount = {
    id,
    name: cleanName,
    username: validation.username ?? username?.trim() || undefined,
    tokenFile: `${id}.token`,
    createdAt: new Date().toISOString(),
  };

  await fs.mkdir(getGithubDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(getAccountTokenPath(account), `${token}\n`, { mode: 0o600 });
  index.accounts.push(account);
  if (!index.activeId) index.activeId = account.id;
  await writeIndex(index);
  await applyActiveToken(index);
  return account;
}

export async function removeGithubAccount(id: string): Promise<boolean> {
  const index = await readIndex();
  const account = index.accounts.find((item) => item.id === id);
  if (!account) return false;

  index.accounts = index.accounts.filter((item) => item.id !== id);
  await fs.rm(getAccountTokenPath(account), { force: true });
  if (index.activeId === id) index.activeId = index.accounts[0]?.id;
  await writeIndex(index);
  await applyActiveToken(index);
  return true;
}

export async function setActiveGithubAccount(id: string): Promise<GithubAccount> {
  const index = await readIndex();
  const account = index.accounts.find((item) => item.id === id);
  if (!account) throw new Error("GitHub account not found");

  index.activeId = id;
  await writeIndex(index);
  await applyActiveToken(index);
  return account;
}

export async function getGithubToken(): Promise<string> {
  const index = await readIndex();
  if (index.accounts.length) return applyActiveToken(index);

  try {
    return (await fs.readFile(getLegacyTokenPath(), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function hasGithubToken(): Promise<boolean> {
  return Boolean(await getGithubToken());
}

/** Backward-compatible single-account save: replaces the active account token. */
export async function saveGithubToken(value: string): Promise<void> {
  const token = normalizeToken(value);
  const validation = await validateGithubToken(token);
  if (!validation.valid) throw new Error("GitHub token verification failed. The token was not saved.");

  const index = await readIndex();
  const active = index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0];

  if (active) {
    await fs.writeFile(getAccountTokenPath(active), `${token}\n`, { mode: 0o600 });
    await applyActiveToken(index);
    return;
  }

  await addGithubAccount("GitHub", token, validation.username);
}

export async function clearGithubToken(): Promise<void> {
  const index = await readIndex();
  await Promise.all(index.accounts.map((account) => fs.rm(getAccountTokenPath(account), { force: true })));
  await fs.rm(getIndexPath(), { force: true });
  await fs.rm(getLegacyTokenPath(), { force: true });
  delete process.env.GITHUB_TOKEN;
}

export async function initializeGithubTokenFromEnvironment(): Promise<boolean> {
  const index = await readIndex();
  if (index.accounts.length) {
    await applyActiveToken(index);
    return Boolean(process.env.GITHUB_TOKEN);
  }

  const legacy = await fs.readFile(getLegacyTokenPath(), "utf8").then((value) => value.trim()).catch(() => "");
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (!legacy && !envToken) return false;

  const candidate = legacy || envToken!;
  const validation = await validateGithubToken(candidate);
  if (!validation.valid) return false;
  await addGithubAccount("GitHub", candidate, validation.username);
  if (envToken) delete process.env.GITHUB_TOKEN;
  return true;
}

export function getGithubTokenPath(): string {
  return getGithubDir();
}

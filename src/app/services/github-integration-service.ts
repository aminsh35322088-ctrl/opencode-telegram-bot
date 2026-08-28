import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

const INTEGRATIONS_DIR = "integrations";
const GITHUB_DIR = "github";
const LEGACY_GITHUB_TOKEN_FILENAME = "github.token";
const INDEX_FILENAME = "accounts.json";

export interface GithubAccount {
  id: string;
  name: string;
  username?: string;
  tokenFile: string;
  createdAt: string;
}

interface GithubIndex {
  activeId?: string;
  accounts: GithubAccount[];
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
    return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [], activeId: parsed.activeId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [] };
    throw error;
  }
}

async function writeIndex(index: GithubIndex): Promise<void> {
  await fs.mkdir(getGithubDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(getIndexPath(), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
}

async function applyActiveToken(index = await readIndex()): Promise<string> {
  const active = index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0];
  if (!active) {
    delete process.env.GITHUB_TOKEN;
    return "";
  }
  const token = (await fs.readFile(getAccountTokenPath(active), "utf8")).trim();
  process.env.GITHUB_TOKEN = token;
  return token;
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
  const index = await readIndex();
  const base = slugify(cleanName);
  let id = base;
  let counter = 2;
  while (index.accounts.some((account) => account.id === id)) id = `${base}-${counter++}`;
  const account: GithubAccount = {
    id,
    name: cleanName,
    ...(username?.trim() ? { username: username.trim() } : {}),
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

/** Backward-compatible single-account save; creates/replaces the default account. */
export async function saveGithubToken(value: string): Promise<void> {
  const index = await readIndex();
  if (index.accounts.length) {
    const active = index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0];
    const token = normalizeToken(value);
    await fs.writeFile(getAccountTokenPath(active), `${token}\n`, { mode: 0o600 });
    await applyActiveToken(index);
    return;
  }
  await addGithubAccount("GitHub", value);
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
  const legacy = await fs.readFile(getLegacyTokenPath(), "utf8").then((v) => v.trim()).catch(() => "");
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (!legacy && !envToken) return false;
  await addGithubAccount("GitHub", legacy || envToken!);
  if (envToken) delete process.env.GITHUB_TOKEN;
  return true;
}

export function getGithubTokenPath(): string {
  return getLegacyTokenPath();
}

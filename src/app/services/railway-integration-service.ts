import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

const INTEGRATIONS_DIR = "integrations";
const RAILWAY_DIR = "railway";
const INDEX_FILENAME = "accounts.json";

export interface RailwayAccount {
  id: string;
  name: string;
  tokenFile: string;
  createdAt: string;
}

interface RailwayIndex {
  activeId: string | undefined;
  accounts: RailwayAccount[];
}

function getRailwayDir(): string {
  return path.join(getRuntimePaths().appHome, INTEGRATIONS_DIR, RAILWAY_DIR);
}

function getIndexPath(): string {
  return path.join(getRailwayDir(), INDEX_FILENAME);
}

function getAccountTokenPath(account: RailwayAccount): string {
  return path.join(getRailwayDir(), account.tokenFile);
}

function normalizeToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("Railway token is empty");
  if (token.length > 1024) throw new Error("Railway token is too long");
  return token;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return slug || "railway";
}

async function readIndex(): Promise<RailwayIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(getIndexPath(), "utf8")) as Partial<RailwayIndex>;
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [], activeId: undefined };
    throw error;
  }
}

async function writeIndex(index: RailwayIndex): Promise<void> {
  await fs.mkdir(getRailwayDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(getIndexPath(), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
}

async function applyActiveToken(index: RailwayIndex): Promise<string> {
  const active = index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0];
  if (!active) {
    delete process.env.RAILWAY_TOKEN;
    return "";
  }
  const token = (await fs.readFile(getAccountTokenPath(active), "utf8")).trim();
  process.env.RAILWAY_TOKEN = token;
  return token;
}

export async function listRailwayAccounts(): Promise<RailwayAccount[]> {
  return (await readIndex()).accounts;
}

export async function getActiveRailwayAccount(): Promise<RailwayAccount | null> {
  const index = await readIndex();
  return index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0] ?? null;
}

export async function addRailwayAccount(name: string, tokenValue: string): Promise<RailwayAccount> {
  const token = normalizeToken(tokenValue);
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Railway account name is empty");

  const index = await readIndex();
  const base = slugify(cleanName);
  let id = base;
  let counter = 2;
  while (index.accounts.some((account) => account.id === id)) id = `${base}-${counter++}`;

  const account: RailwayAccount = {
    id,
    name: cleanName,
    tokenFile: `${id}.token`,
    createdAt: new Date().toISOString(),
  };

  await fs.mkdir(getRailwayDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(getAccountTokenPath(account), `${token}\n`, { mode: 0o600 });
  index.accounts.push(account);
  if (!index.activeId) index.activeId = account.id;
  await writeIndex(index);
  await applyActiveToken(index);
  return account;
}

export async function removeRailwayAccount(id: string): Promise<boolean> {
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

export async function setActiveRailwayAccount(id: string): Promise<RailwayAccount> {
  const index = await readIndex();
  const account = index.accounts.find((item) => item.id === id);
  if (!account) throw new Error("Railway account not found");

  index.activeId = id;
  await writeIndex(index);
  await applyActiveToken(index);
  return account;
}

export async function getRailwayToken(): Promise<string> {
  const index = await readIndex();
  if (index.accounts.length) return applyActiveToken(index);
  return "";
}

export async function hasRailwayToken(): Promise<boolean> {
  return Boolean(await getRailwayToken());
}

export async function clearRailwayToken(): Promise<void> {
  const index = await readIndex();
  await Promise.all(index.accounts.map((account) => fs.rm(getAccountTokenPath(account), { force: true })));
  await fs.rm(getIndexPath(), { force: true });
  delete process.env.RAILWAY_TOKEN;
}

export async function initializeRailwayTokenFromEnvironment(): Promise<boolean> {
  const index = await readIndex();
  if (index.accounts.length) {
    await applyActiveToken(index);
    return Boolean(process.env.RAILWAY_TOKEN);
  }

  const envToken = process.env.RAILWAY_TOKEN?.trim();
  if (!envToken) return false;

  await addRailwayAccount("Railway", envToken);
  delete process.env.RAILWAY_TOKEN;
  return true;
}
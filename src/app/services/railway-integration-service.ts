import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

const INTEGRATIONS_DIR = "integrations";
const RAILWAY_DIR = "railway";
const INDEX_FILENAME = "accounts.json";
const ACCOUNT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

let storeQueue = Promise.resolve();

function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = storeQueue;
  let release!: () => void;
  storeQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous.then(async () => {
    try {
      return await operation();
    } finally {
      release();
    }
  });
}

function getRailwayDir(): string {
  return path.join(getRuntimePaths().appHome, INTEGRATIONS_DIR, RAILWAY_DIR);
}

function getIndexPath(): string {
  return path.join(getRailwayDir(), INDEX_FILENAME);
}

function getAccountTokenPath(account: Pick<RailwayAccount, "id">): string {
  return path.join(getRailwayDir(), `${account.id}.token`);
}

function normalizeToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("Railway token is empty");
  if (token.length > 1024) throw new Error("Railway token is too long");
  return token;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "railway";
}

function isRailwayAccount(value: unknown): value is RailwayAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<RailwayAccount>;
  return (
    typeof account.id === "string" &&
    ACCOUNT_ID_PATTERN.test(account.id) &&
    typeof account.name === "string" &&
    account.name.trim().length > 0 &&
    typeof account.tokenFile === "string" &&
    account.tokenFile === `${account.id}.token` &&
    typeof account.createdAt === "string" &&
    account.createdAt.length > 0
  );
}

function normalizeIndex(value: unknown): RailwayIndex {
  if (!value || typeof value !== "object") {
    return { accounts: [], activeId: undefined };
  }

  const parsed = value as Partial<RailwayIndex>;
  const accounts: RailwayAccount[] = [];
  const seen = new Set<string>();

  if (Array.isArray(parsed.accounts)) {
    for (const account of parsed.accounts) {
      if (!isRailwayAccount(account) || seen.has(account.id)) continue;
      seen.add(account.id);
      accounts.push({ ...account, name: account.name.trim() });
    }
  }

  const activeId = typeof parsed.activeId === "string" && seen.has(parsed.activeId)
    ? parsed.activeId
    : accounts[0]?.id;

  return { accounts, activeId };
}

async function readIndex(): Promise<RailwayIndex> {
  try {
    const content = await fs.readFile(getIndexPath(), "utf8");
    return normalizeIndex(JSON.parse(content));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { accounts: [], activeId: undefined };
    }
    throw error;
  }
}

async function writeIndex(index: RailwayIndex): Promise<void> {
  await fs.mkdir(getRailwayDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(getRailwayDir(), 0o700).catch(() => {});

  const indexPath = getIndexPath();
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(index, null, 2)}\n`;

  try {
    await fs.writeFile(tempPath, content, { mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, indexPath);
    await fs.chmod(indexPath, 0o600).catch(() => {});
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function readAccountToken(account: Pick<RailwayAccount, "id">): Promise<string> {
  const token = normalizeToken(await fs.readFile(getAccountTokenPath(account), "utf8"));
  return token;
}

async function writeAccountToken(account: RailwayAccount, token: string): Promise<void> {
  await fs.mkdir(getRailwayDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(getRailwayDir(), 0o700).catch(() => {});

  const tokenPath = getAccountTokenPath(account);
  const tempPath = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${token}\n`, { mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, tokenPath);
    await fs.chmod(tokenPath, 0o600).catch(() => {});
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function getActiveAccountFromIndex(index: RailwayIndex): Promise<RailwayAccount | null> {
  const active = index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0];
  return active ?? null;
}

export async function listRailwayAccounts(): Promise<RailwayAccount[]> {
  return withStoreLock(async () => (await readIndex()).accounts.map((account) => ({ ...account })));
}

export async function getActiveRailwayAccount(): Promise<RailwayAccount | null> {
  return withStoreLock(async () => {
    const index = await readIndex();
    const account = await getActiveAccountFromIndex(index);
    return account ? { ...account } : null;
  });
}

export async function addRailwayAccount(name: string, tokenValue: string): Promise<RailwayAccount> {
  const token = normalizeToken(tokenValue);
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Railway account name is empty");

  return withStoreLock(async () => {
    const index = await readIndex();
    const base = slugify(cleanName);
    let id = base;
    let counter = 2;
    while (index.accounts.some((account) => account.id === id)) {
      id = `${base}-${counter++}`;
    }

    const account: RailwayAccount = {
      id,
      name: cleanName,
      tokenFile: `${id}.token`,
      createdAt: new Date().toISOString(),
    };

    await writeAccountToken(account, token);
    index.accounts.push(account);
    if (!index.activeId) index.activeId = account.id;

    try {
      await writeIndex(index);
    } catch (error) {
      await fs.rm(getAccountTokenPath(account), { force: true }).catch(() => {});
      throw error;
    }

    return { ...account };
  });
}

export async function removeRailwayAccount(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const index = await readIndex();
    const account = index.accounts.find((item) => item.id === id);
    if (!account) return false;

    const nextAccounts = index.accounts.filter((item) => item.id !== id);
    const nextIndex: RailwayIndex = {
      accounts: nextAccounts,
      activeId: index.activeId === id ? nextAccounts[0]?.id : index.activeId,
    };

    await writeIndex(nextIndex);
    await fs.rm(getAccountTokenPath(account), { force: true });
    return true;
  });
}

export async function setActiveRailwayAccount(id: string): Promise<RailwayAccount> {
  return withStoreLock(async () => {
    const index = await readIndex();
    const account = index.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Railway account not found");

    await readAccountToken(account);
    index.activeId = id;
    await writeIndex(index);
    return { ...account };
  });
}

/** Returns the selected account token without mutating process-wide environment state. */
export async function getRailwayToken(): Promise<string> {
  return withStoreLock(async () => {
    const index = await readIndex();
    const active = await getActiveAccountFromIndex(index);
    return active ? readAccountToken(active) : "";
  });
}

export async function hasRailwayToken(): Promise<boolean> {
  try {
    return Boolean(await getRailwayToken());
  } catch {
    return false;
  }
}

export async function clearRailwayToken(): Promise<void> {
  return withStoreLock(async () => {
    const index = await readIndex();
    await Promise.all(index.accounts.map((account) => fs.rm(getAccountTokenPath(account), { force: true })));
    await fs.rm(getIndexPath(), { force: true });
  });
}

/** Imports the deployment environment token once, then keeps it out of process.env. */
export async function initializeRailwayTokenFromEnvironment(): Promise<boolean> {
  return withStoreLock(async () => {
    const index = await readIndex();
    if (index.accounts.length) return true;

    const envToken = process.env.RAILWAY_TOKEN?.trim();
    if (!envToken) return false;

    const token = normalizeToken(envToken);
    const account: RailwayAccount = {
      id: "railway",
      name: "Railway",
      tokenFile: "railway.token",
      createdAt: new Date().toISOString(),
    };

    await writeAccountToken(account, token);
    try {
      await writeIndex({ accounts: [account], activeId: account.id });
    } catch (error) {
      await fs.rm(getAccountTokenPath(account), { force: true }).catch(() => {});
      throw error;
    }

    delete process.env.RAILWAY_TOKEN;
    return true;
  });
}

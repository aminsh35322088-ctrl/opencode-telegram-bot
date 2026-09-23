import { readAppState, updateAppState } from "../stores/app-state-store.js";

const ACCOUNT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface CloudflareAccessAccount {
  id: string;
  name: string;
  clientIdHint: string;
  createdAt: string;
}

interface StoredCloudflareAccessAccount extends CloudflareAccessAccount {
  clientId: string;
  clientSecret: string;
}

interface CloudflareAccessIndex {
  activeId: string | undefined;
  accounts: StoredCloudflareAccessAccount[];
}

export interface CloudflareAccessCredentials {
  clientId: string;
  clientSecret: string;
}

let storeQueue = Promise.resolve();

function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = storeQueue;
  let release!: () => void;
  storeQueue = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(async () => {
    try { return await operation(); }
    finally { release(); }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getIntegrationState(state: Awaited<ReturnType<typeof readAppState>>): Record<string, unknown> {
  return isRecord(state.integrations) ? state.integrations : {};
}

function clientIdHint(clientId: string): string {
  if (clientId.length <= 10) return clientId;
  return `${clientId.slice(0, 6)}…${clientId.slice(-4)}`;
}

function normalizeIndex(value: unknown): CloudflareAccessIndex {
  if (!isRecord(value)) return { accounts: [], activeId: undefined };
  const raw = value as Partial<CloudflareAccessIndex>;
  const accounts: StoredCloudflareAccessAccount[] = [];
  const seen = new Set<string>();

  if (Array.isArray(raw.accounts)) {
    for (const candidate of raw.accounts) {
      if (
        !isRecord(candidate)
        || typeof candidate.id !== "string"
        || !ACCOUNT_ID_PATTERN.test(candidate.id)
        || typeof candidate.name !== "string"
        || typeof candidate.clientId !== "string"
        || typeof candidate.clientSecret !== "string"
        || typeof candidate.createdAt !== "string"
        || seen.has(candidate.id)
      ) continue;
      const normalizedClientId = candidate.clientId.trim();
      const normalizedSecret = candidate.clientSecret.trim();
      if (!normalizedClientId || !normalizedSecret) continue;
      seen.add(candidate.id);
      accounts.push({
        id: candidate.id,
        name: candidate.name.trim(),
        clientIdHint: clientIdHint(normalizedClientId),
        createdAt: candidate.createdAt,
        clientId: normalizedClientId,
        clientSecret: normalizedSecret,
      });
    }
  }

  const activeId = typeof raw.activeId === "string" && seen.has(raw.activeId)
    ? raw.activeId
    : accounts[0]?.id;
  return { accounts, activeId };
}

async function readIndex(): Promise<CloudflareAccessIndex> {
  const state = await readAppState();
  return normalizeIndex(getIntegrationState(state).cloudflareAccess);
}

async function writeIndex(index: CloudflareAccessIndex): Promise<void> {
  const state = await readAppState();
  await updateAppState({
    integrations: {
      ...getIntegrationState(state),
      cloudflareAccess: index,
    },
  });
}

function publicAccount(account: StoredCloudflareAccessAccount): CloudflareAccessAccount {
  return {
    id: account.id,
    name: account.name,
    clientIdHint: account.clientIdHint,
    createdAt: account.createdAt,
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "cloudflare";
}

function normalizeClientId(value: string): string {
  const clientId = value.trim();
  if (!clientId) throw new Error("Cloudflare Access Client ID is empty");
  if (clientId.length > 2048) throw new Error("Cloudflare Access Client ID is too long");
  return clientId;
}

function normalizeClientSecret(value: string): string {
  const clientSecret = value.trim();
  if (!clientSecret) throw new Error("Cloudflare Access Client Secret is empty");
  if (clientSecret.length > 4096) throw new Error("Cloudflare Access Client Secret is too long");
  return clientSecret;
}

export async function listCloudflareAccessAccounts(): Promise<CloudflareAccessAccount[]> {
  return withStoreLock(async () => (await readIndex()).accounts.map(publicAccount));
}

export async function getActiveCloudflareAccessAccount(): Promise<CloudflareAccessAccount | null> {
  return withStoreLock(async () => {
    const index = await readIndex();
    const account = index.accounts.find((item) => item.id === index.activeId) ?? index.accounts[0];
    return account ? publicAccount(account) : null;
  });
}

export async function getActiveCloudflareAccessCredentials(): Promise<CloudflareAccessCredentials | null> {
  return withStoreLock(async () => {
    const index = await readIndex();
    const account = index.accounts.find((item) => item.id === index.activeId) ?? index.accounts[0];
    return account ? { clientId: account.clientId, clientSecret: account.clientSecret } : null;
  });
}

export async function addCloudflareAccessAccount(
  name: string,
  clientIdValue: string,
  clientSecretValue: string,
): Promise<CloudflareAccessAccount> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Cloudflare account name is empty");
  const clientId = normalizeClientId(clientIdValue);
  const clientSecret = normalizeClientSecret(clientSecretValue);

  return withStoreLock(async () => {
    const index = await readIndex();
    const base = slugify(cleanName);
    let id = base;
    let counter = 2;
    while (index.accounts.some((account) => account.id === id)) id = `${base}-${counter++}`;
    const account: StoredCloudflareAccessAccount = {
      id,
      name: cleanName,
      clientIdHint: clientIdHint(clientId),
      createdAt: new Date().toISOString(),
      clientId,
      clientSecret,
    };
    index.accounts.push(account);
    if (!index.activeId) index.activeId = account.id;
    await writeIndex(index);
    return publicAccount(account);
  });
}

export async function setActiveCloudflareAccessAccount(id: string): Promise<CloudflareAccessAccount> {
  return withStoreLock(async () => {
    const index = await readIndex();
    const account = index.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Cloudflare Access account not found");
    index.activeId = id;
    await writeIndex(index);
    return publicAccount(account);
  });
}

export async function removeCloudflareAccessAccount(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const index = await readIndex();
    if (!index.accounts.some((item) => item.id === id)) return false;
    index.accounts = index.accounts.filter((item) => item.id !== id);
    if (index.activeId === id) index.activeId = index.accounts[0]?.id;
    await writeIndex(index);
    return true;
  });
}

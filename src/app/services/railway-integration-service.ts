import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

const INTEGRATIONS_DIR = "integrations";
const RAILWAY_DIR = "railway";
const INDEX_FILENAME = "accounts.json";
const ACCOUNT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const TOKEN_VALIDATION_TIMEOUT_MS = 10000;

export interface RailwayAccount {
  id: string;
  name: string;
  tokenFile: string;
  createdAt: string;
  tokenType: RailwayTokenType;
}

export type RailwayTokenType = "account" | "workspace" | "project";

export interface RailwayTokenValidation {
  valid: boolean;
  tokenType?: RailwayTokenType;
  subjectName?: string;
  subjectEmail?: string;
  projectId?: string;
  environmentId?: string;
  reason?: "invalid" | "unauthorized" | "timeout" | "network" | "api_error";
}

interface RailwayIndex {
  activeId: string | undefined;
  accounts: RailwayAccount[];
}

let storeQueue = Promise.resolve();

function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = storeQueue;
  let release!: () => void;
  storeQueue = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(async () => {
    try { return await operation(); } finally { release(); }
  });
}

function getRailwayDir(): string { return path.join(getRuntimePaths().appHome, INTEGRATIONS_DIR, RAILWAY_DIR); }
function getIndexPath(): string { return path.join(getRailwayDir(), INDEX_FILENAME); }
function getAccountTokenPath(account: Pick<RailwayAccount, "id">): string { return path.join(getRailwayDir(), `${account.id}.token`); }

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

function isRailwayAccount(value: unknown): value is RailwayAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<RailwayAccount>;
  return typeof account.id === "string" && ACCOUNT_ID_PATTERN.test(account.id)
    && typeof account.name === "string" && account.name.trim().length > 0
    && typeof account.tokenFile === "string" && account.tokenFile === `${account.id}.token`
    && typeof account.createdAt === "string" && account.createdAt.length > 0
    && (account.tokenType === undefined || account.tokenType === "account" || account.tokenType === "workspace" || account.tokenType === "project");
}

function normalizeIndex(value: unknown): RailwayIndex {
  if (!value || typeof value !== "object") return { accounts: [], activeId: undefined };
  const parsed = value as Partial<RailwayIndex>;
  const accounts: RailwayAccount[] = [];
  const seen = new Set<string>();
  if (Array.isArray(parsed.accounts)) {
    for (const account of parsed.accounts) {
      if (!isRailwayAccount(account) || seen.has(account.id)) continue;
      seen.add(account.id);
      accounts.push({ ...account, name: account.name.trim(), tokenType: account.tokenType ?? "account" });
    }
  }
  const activeId = typeof parsed.activeId === "string" && seen.has(parsed.activeId) ? parsed.activeId : accounts[0]?.id;
  return { accounts, activeId };
}

async function readIndex(): Promise<RailwayIndex> {
  try { return normalizeIndex(JSON.parse(await fs.readFile(getIndexPath(), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [], activeId: undefined };
    throw error;
  }
}

async function writeIndex(index: RailwayIndex): Promise<void> {
  await fs.mkdir(getRailwayDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(getRailwayDir(), 0o700).catch(() => {});
  const indexPath = getIndexPath();
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, indexPath);
    await fs.chmod(indexPath, 0o600).catch(() => {});
  } finally { await fs.rm(tempPath, { force: true }).catch(() => {}); }
}

async function readAccountToken(account: Pick<RailwayAccount, "id">): Promise<string> {
  return normalizeToken(await fs.readFile(getAccountTokenPath(account), "utf8"));
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
  } finally { await fs.rm(tempPath, { force: true }).catch(() => {}); }
}

async function getActiveAccountFromIndex(index: RailwayIndex): Promise<RailwayAccount | null> {
  return index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0] ?? null;
}

interface RailwayGraphqlPayload {
  data?: {
    me?: { name?: string | null; email?: string | null } | null;
    projectToken?: { projectId?: string | null; environmentId?: string | null } | null;
    projects?: { edges?: Array<{ node?: { id?: string | null; name?: string | null } | null }> } | null;
  };
  errors?: Array<{ message?: string; extensions?: { code?: string; traceId?: string } }>;
}

async function railwayGraphql(token: string, query: string, headerName: "Authorization" | "Project-Access-Token"): Promise<{ response: Response; payload: RailwayGraphqlPayload }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        [headerName]: headerName === "Authorization" ? `Bearer ${token}` : token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    let payload: RailwayGraphqlPayload = {};
    try { payload = (await response.json()) as RailwayGraphqlPayload; } catch { payload = {}; }
    return { response, payload };
  } finally { clearTimeout(timer); }
}

/** Validate account, workspace, and project Railway credentials without persisting or mutating process.env. */
export async function validateRailwayToken(tokenValue: string): Promise<RailwayTokenValidation> {
  const token = normalizeToken(tokenValue);
  try {
    const accountAttempt = await railwayGraphql(token, "query { me { name email } }", "Authorization");
    const accountMe = accountAttempt.payload.data?.me;
    if (accountAttempt.response.ok && accountMe) {
      return { valid: true, tokenType: "account", subjectName: accountMe.name ?? undefined, subjectEmail: accountMe.email ?? undefined };
    }

    const projectAttempt = await railwayGraphql(token, "query { projectToken { projectId environmentId } }", "Project-Access-Token");
    const projectToken = projectAttempt.payload.data?.projectToken;
    if (projectAttempt.response.ok && projectToken?.projectId && projectToken.environmentId) {
      return { valid: true, tokenType: "project", projectId: projectToken.projectId, environmentId: projectToken.environmentId };
    }

    // Workspace tokens use Authorization: Bearer, but cannot use `me` because that query is scoped to a personal account.
    // Listing one project is sufficient to prove the credential is accepted while staying within workspace scope.
    const workspaceAttempt = await railwayGraphql(token, "query { projects { edges { node { id name } } } }", "Authorization");
    const workspaceProjects = workspaceAttempt.payload.data?.projects?.edges;
    if (workspaceAttempt.response.ok && Array.isArray(workspaceProjects)) {
      return { valid: true, tokenType: "workspace" };
    }

    const attempts = [accountAttempt, projectAttempt, workspaceAttempt];
    if (attempts.some(({ response }) => response.status === 401 || response.status === 403)) return { valid: false, reason: "unauthorized" };
    const apiError = attempts.flatMap(({ payload }) => payload.errors ?? [])[0];
    if (apiError?.message) return { valid: false, reason: "api_error" };
    return { valid: false, reason: "invalid" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { valid: false, reason: "timeout" };
    return { valid: false, reason: "network" };
  }
}

export async function listRailwayAccounts(): Promise<RailwayAccount[]> {
  return withStoreLock(async () => (await readIndex()).accounts.map((account) => ({ ...account })));
}

export async function getActiveRailwayAccount(): Promise<RailwayAccount | null> {
  return withStoreLock(async () => {
    const account = await getActiveAccountFromIndex(await readIndex());
    return account ? { ...account } : null;
  });
}

export async function addRailwayAccount(name: string, tokenValue: string, tokenType: RailwayTokenType = "account"): Promise<RailwayAccount> {
  const token = normalizeToken(tokenValue);
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Railway account name is empty");
  return withStoreLock(async () => {
    const index = await readIndex();
    const base = slugify(cleanName);
    let id = base;
    let counter = 2;
    while (index.accounts.some((account) => account.id === id)) id = `${base}-${counter++}`;
    const account: RailwayAccount = { id, name: cleanName, tokenFile: `${id}.token`, createdAt: new Date().toISOString(), tokenType };
    await writeAccountToken(account, token);
    index.accounts.push(account);
    if (!index.activeId) index.activeId = account.id;
    try { await writeIndex(index); }
    catch (error) { await fs.rm(getAccountTokenPath(account), { force: true }).catch(() => {}); throw error; }
    return { ...account };
  });
}

export async function removeRailwayAccount(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const index = await readIndex();
    const account = index.accounts.find((item) => item.id === id);
    if (!account) return false;
    const nextAccounts = index.accounts.filter((item) => item.id !== id);
    await writeIndex({ accounts: nextAccounts, activeId: index.activeId === id ? nextAccounts[0]?.id : index.activeId });
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

export async function getRailwayToken(): Promise<string> {
  return withStoreLock(async () => {
    const active = await getActiveAccountFromIndex(await readIndex());
    return active ? readAccountToken(active) : "";
  });
}

export async function getActiveRailwayTokenType(): Promise<RailwayTokenType | null> {
  return withStoreLock(async () => (await getActiveAccountFromIndex(await readIndex()))?.tokenType ?? null);
}

export async function hasRailwayToken(): Promise<boolean> {
  try { return Boolean(await getRailwayToken()); } catch { return false; }
}

export async function clearRailwayToken(): Promise<void> {
  return withStoreLock(async () => {
    const index = await readIndex();
    await Promise.all(index.accounts.map((account) => fs.rm(getAccountTokenPath(account), { force: true })));
    await fs.rm(getIndexPath(), { force: true });
  });
}

export async function initializeRailwayTokenFromEnvironment(): Promise<boolean> {
  return withStoreLock(async () => {
    const index = await readIndex();
    if (index.accounts.length) return true;
    const envToken = process.env.RAILWAY_TOKEN?.trim();
    if (!envToken) return false;
    const token = normalizeToken(envToken);
    const account: RailwayAccount = { id: "railway", name: "Railway", tokenFile: "railway.token", createdAt: new Date().toISOString(), tokenType: "project" };
    await writeAccountToken(account, token);
    try { await writeIndex({ accounts: [account], activeId: account.id }); }
    catch (error) { await fs.rm(getAccountTokenPath(account), { force: true }).catch(() => {}); throw error; }
    delete process.env.RAILWAY_TOKEN;
    return true;
  });
}

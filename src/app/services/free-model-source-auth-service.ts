import { randomBytes } from "node:crypto";

const FREEBUFF_LOGIN_ORIGIN = "https://freebuff.com";
const LOGIN_CODE_PATH = "/api/auth/cli/code";
const LOGIN_STATUS_PATH = "/api/auth/cli/status";
const START_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_MS = 15_000;
const ATTEMPT_TTL_MS = 10 * 60_000;

interface PendingFreebuffLogin {
  fingerprintId: string;
  fingerprintHash?: string;
  expiresAt?: string;
  deadline: number;
}

export interface FreebuffLoginStart {
  attemptID: string;
  loginUrl: string;
  expiresAt?: string;
}

export type FreebuffLoginPollResult =
  | { status: "pending" }
  | { status: "connected"; token: string; accountLabel?: string }
  | { status: "expired" };

const pendingFreebuffLogins = new Map<string, PendingFreebuffLogin>();

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}

function safeLoginUrl(value: unknown): string {
  const raw = cleanString(value);
  if (!raw) throw new Error("Freebuff login did not return a login URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Freebuff login returned an invalid login URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "freebuff.com" && !hostname.endsWith(".freebuff.com"))) {
    throw new Error("Freebuff login returned an unexpected login origin");
  }
  return url.toString();
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function startFreebuffLogin(): Promise<FreebuffLoginStart> {
  const fingerprintId = "otb-" + randomBytes(16).toString("hex");
  const response = await fetch(FREEBUFF_LOGIN_ORIGIN + LOGIN_CODE_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `node/${process.versions.node}`,
    },
    body: JSON.stringify({ fingerprintId }),
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const message = cleanString(body?.message) ?? cleanString(body?.error) ?? `HTTP ${response.status}`;
    throw new Error(`Freebuff login could not start: ${message}`);
  }

  const loginUrl = safeLoginUrl(body?.loginUrl);
  const fingerprintHash = cleanString(body?.fingerprintHash);
  const expiresAtRaw = body?.expiresAt;
  const expiresAt = typeof expiresAtRaw === "string" || typeof expiresAtRaw === "number"
    ? String(expiresAtRaw)
    : undefined;
  const attemptID = randomBytes(12).toString("hex");
  pendingFreebuffLogins.set(attemptID, {
    fingerprintId,
    fingerprintHash,
    expiresAt,
    deadline: Date.now() + ATTEMPT_TTL_MS,
  });
  return { attemptID, loginUrl, expiresAt };
}

export async function pollFreebuffLogin(attemptID: string): Promise<FreebuffLoginPollResult> {
  const pending = pendingFreebuffLogins.get(attemptID);
  if (!pending || Date.now() > pending.deadline) {
    pendingFreebuffLogins.delete(attemptID);
    return { status: "expired" };
  }

  const query = new URLSearchParams({ fingerprintId: pending.fingerprintId });
  if (pending.fingerprintHash) query.set("fingerprintHash", pending.fingerprintHash);
  if (pending.expiresAt) query.set("expiresAt", pending.expiresAt);

  const response = await fetch(`${FREEBUFF_LOGIN_ORIGIN}${LOGIN_STATUS_PATH}?${query.toString()}`, {
    headers: { "User-Agent": `node/${process.versions.node}` },
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });

  if (response.status === 401) return { status: "pending" };
  const body = await readJson(response);
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      pendingFreebuffLogins.delete(attemptID);
      return { status: "expired" };
    }
    const message = cleanString(body?.message) ?? cleanString(body?.error) ?? `HTTP ${response.status}`;
    throw new Error(`Freebuff login check failed: ${message}`);
  }

  const user = body?.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return { status: "pending" };
  const record = user as Record<string, unknown>;
  const token = cleanString(record.authToken);
  if (!token) return { status: "pending" };

  pendingFreebuffLogins.delete(attemptID);
  const accountLabel = cleanString(record.email) ?? cleanString(record.name);
  return { status: "connected", token, accountLabel };
}

export function cancelFreebuffLogin(attemptID: string): void {
  pendingFreebuffLogins.delete(attemptID);
}

export function clearExpiredFreebuffLogins(now = Date.now()): void {
  for (const [attemptID, pending] of pendingFreebuffLogins) {
    if (now > pending.deadline) pendingFreebuffLogins.delete(attemptID);
  }
}

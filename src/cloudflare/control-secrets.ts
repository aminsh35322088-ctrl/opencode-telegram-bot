import type { SqlDatabase } from "./control-store.js";
import { decryptCredential, encryptCredential, randomSecret } from "./credentials.js";

export interface InternalControlSecrets {
  CREDENTIAL_MASTER_KEY: string;
  ADMIN_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}
type Roots = {
  TELEGRAM_BOT_TOKEN?: string;
} & Partial<InternalControlSecrets>;
type LegacyWrapped = { version: 1; telegram: string; railway?: string };
type Wrapped = { version: 2; telegram: string };
const legacyContext = "opencode-control-plane:internal-secrets:v1";
const context = "opencode-control-plane:internal-secrets:v2";

/** Domain-separated wrapping keys stay inside the privileged Control Plane. */
async function wrappingKey(token: string, source: string, saltContext = context): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(saltContext),
      info: new TextEncoder().encode(source),
    },
    material,
    256,
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
function valid(value: unknown): value is InternalControlSecrets {
  if (!value || typeof value !== "object") return false;
  const s = value as InternalControlSecrets;
  try {
    return (
      typeof s.CREDENTIAL_MASTER_KEY === "string" &&
      atob(s.CREDENTIAL_MASTER_KEY).length === 32 &&
      typeof s.ADMIN_TOKEN === "string" &&
      !!s.ADMIN_TOKEN &&
      typeof s.TELEGRAM_WEBHOOK_SECRET === "string" &&
      !!s.TELEGRAM_WEBHOOK_SECRET
    );
  } catch {
    return false;
  }
}

/**
 * Internal Control Plane identity is rooted only in the Telegram bot token.
 * Legacy v1 rows are recovered through their Telegram envelope and immediately
 * rewritten as v2 so Railway credentials never participate in bootstrap identity.
 */
export async function resolveControlSecrets(
  sql: SqlDatabase,
  env: Roots,
): Promise<InternalControlSecrets> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    if (valid(env)) return env;
    throw new Error("control_secrets_unavailable");
  }
  const telegramKey = await wrappingKey(env.TELEGRAM_BOT_TOKEN, "telegram");
  const legacyTelegramKey = await wrappingKey(
    env.TELEGRAM_BOT_TOKEN,
    "telegram",
    legacyContext,
  );
  const wrap = async (value: InternalControlSecrets): Promise<string> =>
    JSON.stringify({
      version: 2,
      telegram: await encryptCredential(telegramKey, context, JSON.stringify(value)),
    } satisfies Wrapped);

  let row = [...sql.exec<{ data: string }>("SELECT data FROM control_secrets WHERE id=1")][0];
  if (!row) {
    const generated = {
      CREDENTIAL_MASTER_KEY:
        env.CREDENTIAL_MASTER_KEY ||
        btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
      ADMIN_TOKEN: env.ADMIN_TOKEN || randomSecret(),
      TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET || randomSecret(),
    };
    if (!valid(generated)) throw new Error("control_secrets_unavailable");
    const data = await wrap(generated);
    sql.exec("INSERT OR IGNORE INTO control_secrets(id,data) VALUES(1,?)", data);
    row = [...sql.exec<{ data: string }>("SELECT data FROM control_secrets WHERE id=1")][0];
  }

  try {
    const stored = JSON.parse(row!.data) as Wrapped | LegacyWrapped;
    let decoded: unknown;
    let migrate = false;
    if (stored.version === 2) {
      decoded = JSON.parse(await decryptCredential(telegramKey, context, stored.telegram));
    } else if (stored.version === 1) {
      decoded = JSON.parse(
        await decryptCredential(legacyTelegramKey, legacyContext, stored.telegram),
      );
      migrate = true;
    } else {
      throw new Error("invalid");
    }
    if (!valid(decoded)) throw new Error("invalid");
    for (const name of ["CREDENTIAL_MASTER_KEY", "ADMIN_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] as const)
      if (env[name] && env[name] !== decoded[name]) throw new Error("invalid");
    if (migrate) {
      const data = await wrap(decoded);
      sql.exec("UPDATE control_secrets SET data=? WHERE id=1 AND data=?", data, row!.data);
    }
    return decoded;
  } catch {
    throw new Error("control_secrets_unavailable");
  }
}

/** Fixed-length digest comparison avoids character-position timing leaks. */
export async function equalSecret(actual: string, expected: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(actual), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0 && !!expected;
}

import type { SqlDatabase } from "./control-store.js";
import { decryptCredential, encryptCredential, randomSecret } from "./credentials.js";

export interface InternalControlSecrets {
  CREDENTIAL_MASTER_KEY: string;
  ADMIN_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}
type Roots = {
  TELEGRAM_BOT_TOKEN?: string;
  RAILWAY_API_TOKEN?: string;
} & Partial<InternalControlSecrets>;
type Wrapped = { version: 1; telegram: string; railway: string };
const context = "opencode-control-plane:internal-secrets:v1";
/** Domain-separated wrapping keys stay inside the privileged Control Plane. */
async function wrappingKey(token: string, source: string): Promise<string> {
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
      salt: new TextEncoder().encode(context),
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
/** Two encrypted envelopes permit rotating either user token separately. Corruption fails closed. */
export async function resolveControlSecrets(
  sql: SqlDatabase,
  env: Roots,
): Promise<InternalControlSecrets> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.RAILWAY_API_TOKEN) {
    if (valid(env)) return env;
    throw new Error("control_secrets_unavailable");
  }
  const keys = await Promise.all([
    wrappingKey(env.TELEGRAM_BOT_TOKEN, "telegram"),
    wrappingKey(env.RAILWAY_API_TOKEN, "railway"),
  ]);
  const wrap = async (value: InternalControlSecrets): Promise<string> =>
    JSON.stringify({
      version: 1,
      telegram: await encryptCredential(keys[0]!, context, JSON.stringify(value)),
      railway: await encryptCredential(keys[1]!, context, JSON.stringify(value)),
    });
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
    // Recheck through atomic insert: another request may have initialized while crypto awaited.
    sql.exec("INSERT OR IGNORE INTO control_secrets(id,data) VALUES(1,?)", data);
    row = [...sql.exec<{ data: string }>("SELECT data FROM control_secrets WHERE id=1")][0];
  }
  let value: InternalControlSecrets | undefined;
  let rewrap = false;
  try {
    const stored = JSON.parse(row!.data) as Wrapped;
    if (stored.version !== 1) throw new Error("invalid");
    for (const [index, blob] of [stored.telegram, stored.railway].entries()) {
      try {
        const decoded: unknown = JSON.parse(await decryptCredential(keys[index]!, context, blob));
        if (!valid(decoded)) throw new Error("invalid");
        if (value && JSON.stringify(decoded) !== JSON.stringify(value))
          throw new Error("mismatched_control_identity");
        value = decoded;
      } catch (error) {
        if (error instanceof Error && error.message === "mismatched_control_identity") throw error;
        rewrap = true;
      }
    }
    if (!value) throw new Error("invalid");
    // Never allow leftover legacy bindings to silently replace the active encryption identity.
    for (const name of ["CREDENTIAL_MASTER_KEY", "ADMIN_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] as const)
      if (env[name] && env[name] !== value[name]) throw new Error("invalid");
    if (rewrap) {
      const data = await wrap(value);
      sql.exec("UPDATE control_secrets SET data=? WHERE id=1 AND data=?", data, row!.data);
    }
    return value;
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

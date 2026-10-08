import type { SqlDatabase } from "./control-store.js";
import type { TelegramUpdate } from "./bot-ui.js";
import { decryptCredential, encryptCredential } from "./credentials.js";

export interface CredentialInputContext {
  actor: number;
  chat: number;
  thread: number;
  generation: number;
  providerId: string;
}
export interface CredentialInput extends CredentialInputContext {
  updateId: number;
  expires: number;
  ciphertext: string;
}
export type ProtectedTelegramUpdate = TelegramUpdate & { credentialInput?: CredentialInput };
interface StoredCredential {
  id: string;
  credentialId: string;
  capability: string;
  ciphertext: string;
}
function providerId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    /railway|telegram|^tg(?:$|[._-])|^bot(?:$|[._-])/i.test(value)
  )
    throw new Error("invalid_provider");
  return value;
}
function credentialValue(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 16384 || /[\r\n]/.test(value))
    throw new Error("invalid_credential");
  return value;
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}
function get<T>(sql: SqlDatabase, key: string): T | undefined {
  const row = [...sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key)][0];
  return row ? (JSON.parse(row.data) as T) : undefined;
}

/** Privileged control-plane only. Callers authorize the exact active run and provider reference. */
export class CloudCredentialVault {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly master: string,
  ) {}
  async saveProvider(
    id: string,
    value: string,
  ): Promise<{ id: string; credentialId: string; capability: string; configured: true }> {
    providerId(id);
    credentialValue(value);
    try {
      const credentialId = crypto.randomUUID();
      const capability = "model-provider:" + id;
      const ciphertext = await encryptCredential(
        this.master,
        "credential:" + id,
        JSON.stringify({ id, credentialId, capability, value }),
      );
      this.sql.exec(
        "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        "credential:" + id,
        JSON.stringify({ id, credentialId, capability, ciphertext }),
      );
      return { id, credentialId, capability, configured: true };
    } catch {
      throw new Error("invalid_credential");
    }
  }
  async readLease(
    capability: string,
    credentialId: string,
  ): Promise<{ value: string; expiresAt: number }> {
    try {
      if (
        typeof capability !== "string" ||
        !capability.startsWith("model-provider:") ||
        !uuid(credentialId)
      )
        throw new Error();
      const id = providerId(capability.slice("model-provider:".length));
      const stored = get<StoredCredential>(this.sql, "credential:" + id);
      if (
        !stored ||
        stored.id !== id ||
        stored.credentialId !== credentialId ||
        stored.capability !== capability
      )
        throw new Error();
      const content = JSON.parse(
        await decryptCredential(this.master, "credential:" + id, stored.ciphertext),
      ) as StoredCredential & { value: string };
      if (
        content.id !== id ||
        content.capability !== capability ||
        content.credentialId !== credentialId
      )
        throw new Error();
      return { value: credentialValue(content.value), expiresAt: Date.now() + 60_000 };
    } catch {
      throw new Error("invalid_credential");
    }
  }
  async remove(id: string, credentialId?: string): Promise<void> {
    providerId(id);
    try {
      const stored = get<StoredCredential>(this.sql, "credential:" + id);
      if (
        credentialId !== undefined &&
        (!uuid(credentialId) || stored?.credentialId !== credentialId)
      )
        throw new Error();
      this.sql.exec("DELETE FROM ui_state WHERE key=?", "credential:" + id);
    } catch {
      throw new Error("invalid_credential");
    }
  }
}
function scope(
  update: TelegramUpdate,
): { actor: number; chat: number; thread: number; updateId: number } | undefined {
  const message = update.message;
  if (
    !message ||
    !Number.isSafeInteger(message.from?.id) ||
    !Number.isSafeInteger(message.chat.id) ||
    !Number.isSafeInteger(update.update_id)
  )
    return;
  const rawThread = message.message_thread_id ?? 0;
  if (!Number.isSafeInteger(rawThread) || rawThread < 0) return;
  const thread = rawThread > 1 ? rawThread : 0;
  return { actor: message.from!.id, chat: message.chat.id, thread, updateId: update.update_id! };
}
function inputContext(input: CredentialInput): string {
  return `telegram-credential:${input.updateId}:${input.actor}:${input.chat}:${input.thread}:${input.generation}`;
}
/** Invoke only after webhook authentication AND actor allowlist authorization, before persistence. */
export async function protectTelegramCredentialUpdate(
  update: TelegramUpdate,
  sql: SqlDatabase,
  master: string,
): Promise<ProtectedTelegramUpdate> {
  const current = scope(update);
  const text = update.message?.text;
  if (!current || typeof text !== "string" || /^\s*\//.test(text)) return update;
  try {
    const form = get<{ kind: string; providerId: string; generation: number; expires: number }>(
      sql,
      `form:${current.actor}:${current.chat}:${current.thread}`,
    );
    if (!form || form.kind !== "credential") return update;
    // Expired forms still own sensitive input: protect it before persistence.
    // The reader rejects expiry and generation, so the UI cannot activate it.
    if (!Number.isFinite(form.expires)) throw new Error();
    providerId(form.providerId);
    if (!Number.isSafeInteger(form.generation) || form.generation < 0) throw new Error();
    credentialValue(text);
    const input: CredentialInput = {
      ...current,
      generation: form.generation,
      providerId: form.providerId,
      expires: form.expires,
      ciphertext: "",
    };
    input.ciphertext = await encryptCredential(
      master,
      inputContext(input),
      JSON.stringify({ value: text, providerId: input.providerId, expires: input.expires }),
    );
    return {
      ...update,
      message: { ...update.message!, text: "[credential input protected]" },
      credentialInput: input,
    };
  } catch {
    throw new Error("invalid_credential_input");
  }
}
/** Ephemeral plaintext for the credential form handler only; never pass it to the model. */
export async function readCredentialInput(
  update: TelegramUpdate,
  master: string,
  expected: CredentialInputContext,
): Promise<string> {
  try {
    const input = (update as ProtectedTelegramUpdate).credentialInput;
    const actual = scope(update);
    if (
      !input ||
      !actual ||
      !Number.isFinite(input.expires) ||
      input.expires <= Date.now() ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0
    )
      throw new Error();
    providerId(input.providerId);
    for (const key of ["actor", "chat", "thread", "generation", "providerId"] as const)
      if (input[key] !== expected[key]) throw new Error();
    for (const key of ["actor", "chat", "thread", "updateId"] as const)
      if (input[key] !== actual[key]) throw new Error();
    const content = JSON.parse(
      await decryptCredential(master, inputContext(input), input.ciphertext),
    ) as { value: string; providerId: string; expires: number };
    if (content.providerId !== input.providerId || content.expires !== input.expires)
      throw new Error();
    return credentialValue(content.value);
  } catch {
    throw new Error("invalid_credential_input");
  }
}

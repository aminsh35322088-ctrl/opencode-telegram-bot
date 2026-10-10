import type { SqlDatabase } from "./control-store.js";
import { decryptCredential, encryptCredential } from "./credentials.js";

const KEY = "infrastructure:railway:credential";
const CONTEXT_PREFIX = "opencode-control-plane:infrastructure:railway:";

interface StoredRailwayCredential {
  version: 1;
  accountId: string;
  accountName?: string;
  configuredAt: string;
  ciphertext: string;
}

export interface RailwayCredentialInput {
  accountId: string;
  accountName?: string;
  token: string;
}

export interface RailwayCredential extends RailwayCredentialInput {
  configuredAt: string;
}

export interface RailwayCredentialMetadata {
  accountId: string;
  accountName?: string;
  configuredAt: string;
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value);
}

export class RailwayCredentialStore {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly masterKey: string,
  ) {}

  private stored(): StoredRailwayCredential | undefined {
    const row = [
      ...this.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", KEY),
    ][0];
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.data) as StoredRailwayCredential;
      if (
        value.version !== 1 ||
        !validId(value.accountId) ||
        (value.accountName !== undefined && !validId(value.accountName)) ||
        !Number.isFinite(Date.parse(value.configuredAt)) ||
        typeof value.ciphertext !== "string" ||
        value.ciphertext.length < 16
      )
        throw new Error("invalid");
      return value;
    } catch {
      throw new Error("railway_credential_corrupt");
    }
  }

  metadata(): RailwayCredentialMetadata | undefined {
    const value = this.stored();
    return value
      ? {
          accountId: value.accountId,
          ...(value.accountName ? { accountName: value.accountName } : {}),
          configuredAt: value.configuredAt,
        }
      : undefined;
  }

  async read(): Promise<RailwayCredential | undefined> {
    const value = this.stored();
    if (!value) return undefined;
    const token = await decryptCredential(
      this.masterKey,
      CONTEXT_PREFIX + value.accountId,
      value.ciphertext,
    ).catch(() => {
      throw new Error("railway_credential_corrupt");
    });
    if (!token || token.length > 4096) throw new Error("railway_credential_corrupt");
    return {
      accountId: value.accountId,
      ...(value.accountName ? { accountName: value.accountName } : {}),
      configuredAt: value.configuredAt,
      token,
    };
  }

  async save(input: RailwayCredentialInput): Promise<RailwayCredentialMetadata> {
    if (!validId(input.accountId) || !input.token || input.token.length > 4096)
      throw new Error("invalid_railway_credential");
    if (input.accountName !== undefined && !validId(input.accountName))
      throw new Error("invalid_railway_credential");
    const configuredAt = new Date().toISOString();
    const value: StoredRailwayCredential = {
      version: 1,
      accountId: input.accountId,
      ...(input.accountName ? { accountName: input.accountName } : {}),
      configuredAt,
      ciphertext: await encryptCredential(
        this.masterKey,
        CONTEXT_PREFIX + input.accountId,
        input.token,
      ),
    };
    this.sql.exec(
      "INSERT INTO ui_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      KEY,
      JSON.stringify(value),
    );
    return {
      accountId: value.accountId,
      ...(value.accountName ? { accountName: value.accountName } : {}),
      configuredAt,
    };
  }

  async replace(input: RailwayCredentialInput): Promise<RailwayCredentialMetadata> {
    const current = this.stored();
    if (!current) throw new Error("railway_credential_missing");
    if (current.accountId !== input.accountId) throw new Error("railway_account_mismatch");
    return this.save(input);
  }

  clear(): void {
    this.sql.exec("DELETE FROM ui_state WHERE key=?", KEY);
  }
}

import type { TelegramUpdate } from "./bot-ui.js";

export interface RailwayCredentialInputContext {
  actor: number;
  chat: number;
  thread: number;
  generation: number;
}
interface ProtectedRailwayInput extends RailwayCredentialInputContext {
  updateId: number;
  expires: number;
  ciphertext: string;
}
export type ProtectedRailwayTelegramUpdate = TelegramUpdate & {
  railwayCredentialInput?: ProtectedRailwayInput;
};
function telegramScope(update: TelegramUpdate): (RailwayCredentialInputContext & { updateId: number }) | undefined {
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
  return {
    actor: message.from!.id,
    chat: message.chat.id,
    thread: rawThread > 1 ? rawThread : 0,
    generation: 0,
    updateId: update.update_id!,
  };
}
function railwayInputContext(input: ProtectedRailwayInput): string {
  return `telegram-infrastructure-credential:railway:${input.updateId}:${input.actor}:${input.chat}:${input.thread}:${input.generation}`;
}
function boundedToken(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\r\n]/u.test(value))
    throw new Error("invalid_railway_credential_input");
  return value.trim();
}
/** Protect first-run/Settings Railway input before the Telegram update is persisted. */
export async function protectRailwayCredentialUpdate(
  update: TelegramUpdate,
  sql: SqlDatabase,
  master: string,
): Promise<ProtectedRailwayTelegramUpdate> {
  const current = telegramScope(update);
  const text = update.message?.text ?? update.message?.caption;
  if (!current || typeof text !== "string" || /^\s*\//u.test(text)) return update;
  const row = [
    ...sql.exec<{ data: string }>(
      "SELECT data FROM ui_state WHERE key=?",
      `form:${current.actor}:${current.chat}:${current.thread}`,
    ),
  ][0];
  if (!row) return update;
  try {
    const form = JSON.parse(row.data) as { kind?: string; generation?: number; expires?: number };
    if (form.kind !== "railway_credential") return update;
    if (
      !Number.isSafeInteger(form.generation) ||
      form.generation! < 0 ||
      !Number.isFinite(form.expires)
    )
      throw new Error();
    const input: ProtectedRailwayInput = {
      actor: current.actor,
      chat: current.chat,
      thread: current.thread,
      updateId: current.updateId,
      generation: form.generation!,
      expires: form.expires!,
      ciphertext: "",
    };
    input.ciphertext = await encryptCredential(
      master,
      railwayInputContext(input),
      boundedToken(text),
    );
    return {
      ...update,
      message: {
        ...update.message!,
        text: "[credential input protected]",
        ...(update.message?.caption !== undefined
          ? { caption: "[credential input protected]" }
          : {}),
      },
      railwayCredentialInput: input,
    };
  } catch {
    throw new Error("invalid_railway_credential_input");
  }
}

/** Decrypt only in the Railway setup handler; never expose to model/runtime paths. */
export async function readRailwayCredentialInput(
  update: TelegramUpdate,
  master: string,
  expected: RailwayCredentialInputContext,
): Promise<string> {
  try {
    const input = (update as ProtectedRailwayTelegramUpdate).railwayCredentialInput;
    const current = telegramScope(update);
    if (
      !input ||
      !current ||
      input.expires <= Date.now() ||
      !Number.isFinite(input.expires) ||
      input.actor !== expected.actor ||
      input.chat !== expected.chat ||
      input.thread !== expected.thread ||
      input.generation !== expected.generation ||
      input.actor !== current.actor ||
      input.chat !== current.chat ||
      input.thread !== current.thread ||
      input.updateId !== current.updateId
    )
      throw new Error();
    return boundedToken(
      await decryptCredential(master, railwayInputContext(input), input.ciphertext),
    );
  } catch {
    throw new Error("invalid_railway_credential_input");
  }
}

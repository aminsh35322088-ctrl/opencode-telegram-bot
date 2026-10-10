import type { SqlDatabase } from "./control-store.js";
import { decryptCredential, encryptCredential } from "./credentials.js";

export type IntegrationId = "github" | "tailscale";
export interface IntegrationConnection {
  id: IntegrationId;
  credentialId: string;
  capability: string;
  configured: true;
  accountConnected: true;
  /** API authentication does not establish Core repository transport or a VPN. */
  connected: false;
  reason: "core_runtime_unavailable";
  configuredAt: string;
  username?: string;
  tailnet?: string;
  visibleDevices?: number;
}
interface StoredCredential {
  id: IntegrationId;
  credentialId: string;
  capability: string;
  ciphertext: string;
}
function integrationId(id: unknown): IntegrationId {
  if (id !== "github" && id !== "tailscale") throw new Error("invalid_integration");
  return id;
}
function tokenValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_integration_credential");
  const token = value.trim();
  if (!token || token.length > 16384 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("invalid_integration_credential");
  return token;
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("integration_invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024 * 1024) throw new Error("integration_invalid_response");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("integration_invalid_response");
  } finally {
    reader.releaseLock();
  }
}

/** Privileged control-plane API authentication only. No credentials enter public snapshots. */
export class CloudIntegrationConnections {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly master: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  async connect(idValue: IntegrationId, value: string): Promise<IntegrationConnection> {
    const id = integrationId(idValue);
    const token = tokenValue(value);
    if (id === "tailscale" && !token.startsWith("tskey-api-"))
      throw new Error("tailscale_api_token_required");
    const url =
      id === "github"
        ? "https://api.github.com/user"
        : "https://api.tailscale.com/api/v2/tailnet/-/devices";
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(id === "github"
            ? {
                "User-Agent": "opencode-telegram-bot",
                "X-GitHub-Api-Version": "2022-11-28",
              }
            : {}),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const reason = error instanceof Error && /too many subrequests|subrequest limit/i.test(error.message)
        ? "subrequest_limit" : error instanceof Error && /Illegal invocation/.test(error.message)
          ? "receiver" : error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
          ? "timeout" : "transport";
      // Fixed metadata only; exception messages and submitted credential values are excluded.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ event: "integration_account_verification_failed", integrationId: id, stage: "transport", reason }));
      throw new Error("integration_unavailable");
    }
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ event: "integration_account_verification_failed", integrationId: id, stage: "response", status: response.status }));
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) throw new Error("integration_unauthorized");
      if (response.status === 403) throw new Error("integration_forbidden");
      throw new Error("integration_unavailable");
    }
    const payload = await boundedJson(response);
    const identity: Pick<IntegrationConnection, "username" | "tailnet" | "visibleDevices"> = {};
    if (id === "github") {
      if (
        typeof payload.login !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(payload.login)
      )
        throw new Error("integration_invalid_response");
      identity.username = payload.login;
    } else {
      if (!Array.isArray(payload.devices)) throw new Error("integration_invalid_response");
      identity.tailnet = "-";
      identity.visibleDevices = payload.devices.length;
    }
    const credentialId = crypto.randomUUID();
    const capability = `integration:${id}`;
    const key = `integration-credential:${id}`;
    let ciphertext: string;
    try {
      ciphertext = await encryptCredential(
        this.master,
        key,
        JSON.stringify({ id, credentialId, capability, value: token }),
      );
      this.sql.exec(
        "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        key,
        JSON.stringify({ id, credentialId, capability, ciphertext }),
      );
    } catch {
      throw new Error("invalid_integration_credential");
    }
    return {
      id,
      credentialId,
      capability,
      configured: true,
      accountConnected: true,
      connected: false,
      reason: "core_runtime_unavailable",
      configuredAt: new Date().toISOString(),
      ...identity,
    };
  }
  /** For privileged revalidation only; never expose via model-provider credential leases. */
  async readCredential(idValue: IntegrationId, credentialId: string): Promise<string> {
    try {
      const id = integrationId(idValue);
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(credentialId)
      )
        throw new Error();
      const key = `integration-credential:${id}`;
      const row = [
        ...this.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key),
      ][0];
      if (!row) throw new Error();
      const stored = JSON.parse(row.data) as StoredCredential;
      if (
        stored.id !== id ||
        stored.credentialId !== credentialId ||
        stored.capability !== `integration:${id}`
      )
        throw new Error();
      const content = record(
        JSON.parse(await decryptCredential(this.master, key, stored.ciphertext)),
      );
      if (
        content.id !== id ||
        content.credentialId !== credentialId ||
        content.capability !== stored.capability
      )
        throw new Error();
      return tokenValue(content.value);
    } catch {
      throw new Error("invalid_integration_credential");
    }
  }
  remove(idValue: IntegrationId): void {
    const id = integrationId(idValue);
    this.sql.exec("DELETE FROM ui_state WHERE key=?", `integration-credential:${id}`);
  }
}

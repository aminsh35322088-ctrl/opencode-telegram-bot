import type { SqlDatabase } from "./control-store.js";
import { decryptCredential, encryptCredential } from "./credentials.js";

export interface IntegrationDefinition {
  id: string;
  credentialType: string;
  capabilities: readonly string[];
  requiredScopes?: Readonly<Record<string, readonly string[]>>;
  runtime: "core";
  persistentState: boolean;
  processLifecycle: boolean;
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function scopes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    new Set(value).size === value.length &&
    value.every(
      (s) => typeof s === "string" && s.length > 0 && s.length <= 256 && !/[\x00-\x20\x7f]/.test(s),
    )
  );
}
function material(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("invalid_credential");
}
export class CapabilityRegistry {
  private readonly definitions = new Map<string, IntegrationDefinition>();
  register(definition: IntegrationDefinition): void {
    if (
      !identifier(definition.id) ||
      !identifier(definition.credentialType) ||
      definition.runtime !== "core" ||
      typeof definition.persistentState !== "boolean" ||
      typeof definition.processLifecycle !== "boolean" ||
      !Array.isArray(definition.capabilities) ||
      !definition.capabilities.length ||
      !definition.capabilities.every(identifier) ||
      new Set(definition.capabilities).size !== definition.capabilities.length ||
      this.definitions.has(definition.id)
    )
      throw new Error("invalid_integration_definition");
    if (
      definition.requiredScopes &&
      Object.entries(definition.requiredScopes).some(
        ([capability, required]) =>
          !definition.capabilities.includes(capability) || !scopes(required),
      )
    )
      throw new Error("invalid_integration_definition");
    this.definitions.set(
      definition.id,
      Object.freeze({
        ...definition,
        capabilities: Object.freeze([...definition.capabilities]),
        ...(definition.requiredScopes
          ? {
              requiredScopes: Object.freeze(
                Object.fromEntries(
                  Object.entries(definition.requiredScopes).map(([capability, required]) => [
                    capability,
                    Object.freeze([...required]),
                  ]),
                ),
              ),
            }
          : {}),
      }),
    );
  }
  get(id: string): IntegrationDefinition | undefined {
    return this.definitions.get(id);
  }
  list(): IntegrationDefinition[] {
    return [...this.definitions.values()];
  }
}
export interface CredentialOwner {
  workerId: string;
  topicId: string;
  generation: number;
  sessionId: string;
}
export interface CredentialReference {
  integrationId: string;
  credentialId: string;
  scopes: string[];
  configured: true;
}
export interface CapabilityGrant extends CredentialReference {
  capabilities: string[];
}
export interface CredentialRequest extends CredentialOwner {
  integrationId: string;
  credentialId: string;
  capability: string;
  scopes: string[];
  resource?: string;
}
interface StoredCredential extends CredentialReference {
  ciphertext: string;
}
interface StoredLease extends CredentialRequest {
  leaseId: string;
  expiresAt: number;
}
const ownerKeys = ["workerId", "topicId", "generation", "sessionId"] as const;

/** Only the signed privileged Worker transport may call acquire; tools receive capabilities. */
export class CloudCapabilityBroker {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly master: string,
    private readonly registry: CapabilityRegistry,
    private readonly authority: (
      owner: CredentialOwner,
    ) => (CredentialOwner & { grants: CapabilityGrant[] }) | undefined,
    private readonly now: () => number = Date.now,
    private readonly deliver: (
      value: string,
      request: CredentialRequest,
    ) => Promise<string> = async (value) => value,
  ) {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS capability_leases(id TEXT PRIMARY KEY,expires INTEGER NOT NULL,data TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS capability_lease_expiration ON capability_leases(expires)",
    );
  }

  private read<T>(key: string): T | undefined {
    const row = [
      ...this.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key),
    ][0];
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  private write(key: string, data: unknown): void {
    this.sql.exec(
      "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      key,
      JSON.stringify(data),
    );
  }
  reference(integrationId: string, credentialId: string): CredentialReference | undefined {
    if (!uuid(credentialId)) return undefined;
    const stored = this.read<StoredCredential>("capability-credential:" + credentialId);
    if (!stored || stored.integrationId !== integrationId) return undefined;
    return { integrationId, credentialId, scopes: [...stored.scopes], configured: true };
  }
  async save(
    integrationId: string,
    value: string,
    grantedScopes: string[],
    importedId?: string,
  ): Promise<CredentialReference> {
    if (!this.registry.get(integrationId) || !scopes(grantedScopes))
      throw new Error("invalid_credential");
    material(value);
    if (
      importedId !== undefined &&
      (!uuid(importedId) || this.read("capability-credential:" + importedId))
    )
      throw new Error("invalid_credential");
    const reference: CredentialReference = {
      integrationId,
      credentialId: importedId ?? crypto.randomUUID(),
      scopes: [...grantedScopes],
      configured: true,
    };
    const key = "capability-credential:" + reference.credentialId;
    try {
      const ciphertext = await encryptCredential(
        this.master,
        key,
        JSON.stringify({ ...reference, value }),
      );
      if (this.read(key)) throw new Error("invalid_credential");
      this.write(key, { ...reference, ciphertext });
      return reference;
    } catch {
      throw new Error("invalid_credential");
    }
  }
  async rotate(credentialId: string, value: string): Promise<CredentialReference> {
    if (!uuid(credentialId)) throw new Error("invalid_credential");
    const before = this.read<StoredCredential>("capability-credential:" + credentialId);
    if (!before) throw new Error("invalid_credential");
    const next = await this.save(before.integrationId, value, before.scopes);
    // Remove only this exact reference. Account switching never changes a global environment.
    this.remove(credentialId);
    return next;
  }
  remove(credentialId: string): void {
    if (!uuid(credentialId)) throw new Error("invalid_credential");
    this.sql.exec("DELETE FROM ui_state WHERE key=?", "capability-credential:" + credentialId);
  }
  removeIntegration(integrationId: string): void {
    if (!this.registry.get(integrationId)) throw new Error("invalid_integration");
    this.sql.exec(
      "DELETE FROM ui_state WHERE key GLOB 'capability-credential:*' AND json_extract(data,'$.integrationId')=?",
      integrationId,
    );
  }
  /** Privileged account validation/migration only; never publish this on the Worker/tool surface. */
  async readAccount(integrationId: string, credentialId: string): Promise<string> {
    try {
      if (!uuid(credentialId) || !this.registry.get(integrationId)) throw new Error();
      const key = "capability-credential:" + credentialId;
      const stored = this.read<StoredCredential>(key);
      if (!stored || stored.integrationId !== integrationId) throw new Error();
      const content = JSON.parse(await decryptCredential(this.master, key, stored.ciphertext));
      if (
        content.integrationId !== integrationId ||
        content.credentialId !== credentialId ||
        JSON.stringify(content.scopes) !== JSON.stringify(stored.scopes) ||
        this.read<StoredCredential>(key)?.ciphertext !== stored.ciphertext
      )
        throw new Error();
      material(content.value);
      return content.value;
    } catch {
      throw new Error("invalid_credential");
    }
  }
  private authorized(owner: CredentialOwner, request: CredentialRequest): StoredCredential {
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).some(
        (k) =>
          ![
            ...ownerKeys,
            "integrationId",
            "credentialId",
            "capability",
            "scopes",
            "resource",
            "leaseId",
            "expiresAt",
          ].includes(k as never),
      ) ||
      (request.resource !== undefined &&
        (typeof request.resource !== "string" ||
          !request.resource ||
          request.resource.length > 256 ||
          /[\x00-\x1f\x7f]/.test(request.resource)))
    )
      throw new Error("credential_scope_rejected");
    const current = this.authority(owner);
    if (
      !current ||
      ownerKeys.some((k) => owner[k] !== current[k] || owner[k] !== request[k]) ||
      !identifier(owner.workerId) ||
      !/^-?\d+:\d+$/.test(owner.topicId) ||
      !owner.sessionId ||
      !Number.isSafeInteger(owner.generation) ||
      owner.generation < 1 ||
      !uuid(request.credentialId) ||
      !scopes(request.scopes) ||
      !this.registry.get(request.integrationId)?.capabilities.includes(request.capability)
    )
      throw new Error("credential_scope_rejected");
    const stored = this.read<StoredCredential>("capability-credential:" + request.credentialId);
    const grant = current.grants.find(
      (g) =>
        g.integrationId === request.integrationId &&
        g.credentialId === request.credentialId &&
        g.configured === true,
    );
    if (
      !stored ||
      stored.integrationId !== request.integrationId ||
      !grant ||
      !grant.capabilities.includes(request.capability) ||
      request.scopes.some((s) => !grant.scopes.includes(s) || !stored.scopes.includes(s)) ||
      this.registry
        .get(request.integrationId)
        ?.requiredScopes?.[request.capability]?.some((s) => !request.scopes.includes(s))
    )
      throw new Error("credential_scope_rejected");
    return stored;
  }
  authorize(
    owner: CredentialOwner,
    request: CredentialRequest,
  ): { authorized: true; expiresAt: number } {
    if (request && (Object.hasOwn(request, "leaseId") || Object.hasOwn(request, "expiresAt")))
      throw new Error("credential_scope_rejected");
    this.authorized(owner, request);
    return { authorized: true, expiresAt: this.now() + 60_000 };
  }
  async acquire(
    owner: CredentialOwner,
    request: CredentialRequest,
  ): Promise<{ leaseId: string; expiresAt: number; value: string }> {
    if (request && (Object.hasOwn(request, "leaseId") || Object.hasOwn(request, "expiresAt")))
      throw new Error("credential_scope_rejected");
    const stored = this.authorized(owner, request);
    const key = "capability-credential:" + request.credentialId;
    let value: string;
    try {
      const content = JSON.parse(await decryptCredential(this.master, key, stored.ciphertext));
      if (
        content.integrationId !== request.integrationId ||
        content.credentialId !== request.credentialId ||
        JSON.stringify(content.scopes) !== JSON.stringify(stored.scopes)
      )
        throw new Error();
      material(content.value);
      value = content.value;
    } catch {
      throw new Error("invalid_credential");
    }
    value = await this.deliver(value, request);
    material(value);
    // Durable Object requests can interleave at WebCrypto/network awaits. Recheck both authority and ciphertext.
    if (this.authorized(owner, request).ciphertext !== stored.ciphertext)
      throw new Error("credential_scope_rejected");
    const expiresAt = this.now() + 60_000;
    const leaseId = crypto.randomUUID();
    this.sql.exec("DELETE FROM capability_leases WHERE expires<=?", this.now());
    const count =
      [...this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM capability_leases")][0]?.n ?? 0;
    if (count >= 4096) throw new Error("credential_lease_capacity");
    this.sql.exec(
      "INSERT INTO capability_leases(id,expires,data) VALUES(?,?,?)",
      leaseId,
      expiresAt,
      JSON.stringify({ ...request, scopes: [...request.scopes], leaseId, expiresAt }),
    );
    return { leaseId, expiresAt, value };
  }
  private readLease(leaseId: string): StoredLease | undefined {
    const row = [
      ...this.sql.exec<{ data: string }>("SELECT data FROM capability_leases WHERE id=?", leaseId),
    ][0];
    return row ? (JSON.parse(row.data) as StoredLease) : undefined;
  }
  validate(owner: CredentialOwner, leaseId: string): { valid: true; expiresAt: number } {
    try {
      if (!uuid(leaseId)) throw new Error();
      const lease = this.readLease(leaseId);
      if (!lease || lease.expiresAt <= this.now()) throw new Error();
      this.authorized(owner, lease);
      return { valid: true, expiresAt: lease.expiresAt };
    } catch {
      throw new Error("credential_lease_rejected");
    }
  }
  release(owner: CredentialOwner, leaseId: string): void {
    if (!uuid(leaseId)) throw new Error("credential_lease_rejected");
    const lease = this.readLease(leaseId);
    if (lease && ownerKeys.some((k) => lease[k] !== owner[k]))
      throw new Error("credential_lease_rejected");
    this.sql.exec("DELETE FROM capability_leases WHERE id=?", leaseId);
  }
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export interface IntegrationCredentialLeaseOwner {
  nodeId: string;
  generation: number;
  chatId: number;
  threadId: number;
  sessionId: string;
}

export interface IntegrationCredentialLeaseDependencies {
  githubCredential(accountId: string): Promise<string | null>;
  tailscaleAuthKey(credentialId: string): Promise<string | null>;
  now?: () => number;
  leaseId?: () => string;
}

interface LeaseRecord extends IntegrationCredentialLeaseOwner {
  integrationId: "github" | "tailscale";
  credentialId: string;
  capability: "repo.read" | "repo.write" | "session.access" | "device.enroll";
  resource?: string;
  expiresAt: number;
  digest: Buffer;
}

const MAX_LEASES = 512;
const LEASE_LIFETIME_MS = 55_000;
const AUTHORIZATION_LIFETIME_MS = 10_000;
const TAILSCALE_CAPABILITIES = new Set([
  "device.enroll",
  "network.status",
  "network.devices",
  "ssh.exec",
]);
const GITHUB_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const TAILSCALE_PEER_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const GITHUB_ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/u;

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === new Set(allowed).size && keys.every((key) => allowed.includes(key));
}

function validOwner(owner: IntegrationCredentialLeaseOwner): boolean {
  return typeof owner.nodeId === "string"
    && owner.nodeId.length > 0
    && owner.nodeId.length <= 128
    && Number.isSafeInteger(owner.generation)
    && owner.generation > 0
    && Number.isSafeInteger(owner.chatId)
    && owner.chatId !== 0
    && Number.isSafeInteger(owner.threadId)
    && owner.threadId > 1
    && typeof owner.sessionId === "string"
    && owner.sessionId.length > 0
    && owner.sessionId.length <= 256;
}

function sameOwner(left: IntegrationCredentialLeaseOwner, right: IntegrationCredentialLeaseOwner): boolean {
  return left.nodeId === right.nodeId
    && left.generation === right.generation
    && left.chatId === right.chatId
    && left.threadId === right.threadId
    && left.sessionId === right.sessionId;
}

function ownerClaimsMatch(payload: Record<string, unknown>, owner: IntegrationCredentialLeaseOwner): boolean {
  return payload.workerId === owner.nodeId
    && payload.topicId === `${owner.chatId}:${owner.threadId}`
    && payload.generation === owner.generation
    && payload.sessionId === owner.sessionId;
}

function validMaterial(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 16_384
    && !/[\x00-\x1f\x7f]/u.test(value);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function digestMatches(expected: Buffer, value: string): boolean {
  const actual = digest(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Short-lived, memory-only grants for the trusted Core Worker adapters.
 * Credential values are returned only to the authenticated Worker transport;
 * this broker retains a digest so every use can be fenced against rotation.
 */
export class IntegrationCredentialLeaseBroker {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly now: () => number;
  private readonly createLeaseId: () => string;

  constructor(private readonly dependencies: IntegrationCredentialLeaseDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.createLeaseId = dependencies.leaseId ?? randomUUID;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(id);
    }
  }

  private async currentMaterial(lease: Pick<LeaseRecord, "integrationId" | "credentialId">): Promise<string | null> {
    try {
      const value = lease.integrationId === "github"
        ? await this.dependencies.githubCredential(lease.credentialId)
        : await this.dependencies.tailscaleAuthKey(lease.credentialId);
      return validMaterial(value) ? value : null;
    } catch {
      return null;
    }
  }

  async acquire(payloadValue: unknown, owner: IntegrationCredentialLeaseOwner): Promise<{
    value: string;
    leaseId: string;
    expiresAt: number;
  }> {
    const payload = object(payloadValue);
    if (!validOwner(owner) || !ownerClaimsMatch(payload, owner)) throw new Error("Integration credential capability denied");
    const requiredKeys = [
      "workerId", "topicId", "generation", "sessionId", "integrationId", "credentialId", "capability", "scopes",
    ];
    if ((!exactKeys(payload, requiredKeys) && !exactKeys(payload, [...requiredKeys, "resource"]))
      || typeof payload.integrationId !== "string"
      || typeof payload.credentialId !== "string"
      || typeof payload.capability !== "string"
      || !Array.isArray(payload.scopes)
      || payload.scopes.length !== 1
      || payload.scopes[0] !== payload.capability) {
      throw new Error("Integration credential capability denied");
    }

    let integrationId: LeaseRecord["integrationId"];
    let capability: LeaseRecord["capability"];
    let resource: string | undefined;
    if (payload.integrationId === "github") {
      if (typeof payload.credentialId !== "string"
        || !GITHUB_ACCOUNT_ID.test(payload.credentialId)) {
        throw new Error("Integration credential capability denied");
      }
      if (payload.capability === "session.access") {
        if (!exactKeys(payload, requiredKeys)) {
          throw new Error("Integration credential capability denied");
        }
        integrationId = "github";
        capability = "session.access";
      } else if (["repo.read", "repo.write"].includes(payload.capability)) {
        if (!exactKeys(payload, [...requiredKeys, "resource"])
          || typeof payload.resource !== "string"
          || !GITHUB_REPOSITORY.test(payload.resource)) {
          throw new Error("Integration credential capability denied");
        }
        integrationId = "github";
        capability = payload.capability as LeaseRecord["capability"];
        resource = payload.resource;
      } else {
        throw new Error("Integration credential capability denied");
      }
    } else if (payload.integrationId === "tailscale") {
      if (!exactKeys(payload, requiredKeys)
        || payload.credentialId !== "auth-key"
        || payload.capability !== "device.enroll") {
        throw new Error("Integration credential capability denied");
      }
      integrationId = "tailscale";
      capability = "device.enroll";
    } else {
      throw new Error("Integration credential capability denied");
    }

    const value = await this.currentMaterial({ integrationId, credentialId: payload.credentialId });
    if (!value || (integrationId === "tailscale" && !value.startsWith("tskey-auth-"))) {
      throw new Error("Integration credential unavailable");
    }

    this.pruneExpired();
    if (this.leases.size >= MAX_LEASES) throw new Error("Integration credential capacity exceeded");
    const leaseId = this.createLeaseId();
    if (!leaseId || leaseId.length > 128 || this.leases.has(leaseId)) {
      throw new Error("Integration credential capacity exceeded");
    }
    const expiresAt = this.now() + LEASE_LIFETIME_MS;
    this.leases.set(leaseId, {
      ...owner,
      integrationId,
      credentialId: payload.credentialId,
      capability,
      ...(resource ? { resource } : {}),
      expiresAt,
      digest: digest(value),
    });
    return { value, leaseId, expiresAt };
  }

  async validate(payloadValue: unknown, owner: IntegrationCredentialLeaseOwner): Promise<{ valid: boolean }> {
    const payload = object(payloadValue);
    if (!validOwner(owner) || !exactKeys(payload, ["leaseId"])
      || typeof payload.leaseId !== "string" || payload.leaseId.length > 128) {
      throw new Error("Integration credential lease denied");
    }
    this.pruneExpired();
    const lease = this.leases.get(payload.leaseId);
    if (!lease || !sameOwner(lease, owner) || lease.expiresAt <= this.now()) return { valid: false };
    const value = await this.currentMaterial(lease);
    if (!value || (lease.integrationId === "tailscale" && !value.startsWith("tskey-auth-"))) return { valid: false };
    return { valid: digestMatches(lease.digest, value) };
  }

  async release(payloadValue: unknown, owner: IntegrationCredentialLeaseOwner): Promise<{ released: boolean }> {
    const payload = object(payloadValue);
    if (!validOwner(owner) || !exactKeys(payload, ["leaseId"])
      || typeof payload.leaseId !== "string" || payload.leaseId.length > 128) {
      throw new Error("Integration credential lease denied");
    }
    const lease = this.leases.get(payload.leaseId);
    if (!lease || !sameOwner(lease, owner)) return { released: false };
    this.leases.delete(payload.leaseId);
    return { released: true };
  }

  async authorize(payloadValue: unknown, owner: IntegrationCredentialLeaseOwner): Promise<{
    authorized: true;
    expiresAt: number;
  }> {
    const payload = object(payloadValue);
    if (!validOwner(owner) || !ownerClaimsMatch(payload, owner)
      || typeof payload.integrationId !== "string"
      || typeof payload.credentialId !== "string"
      || typeof payload.capability !== "string"
      || !Array.isArray(payload.scopes)
      || payload.scopes.length !== 1
      || payload.scopes[0] !== payload.capability) {
      throw new Error("Integration capability denied");
    }
    const keys = [
      "workerId", "topicId", "generation", "sessionId", "integrationId", "credentialId", "capability", "scopes",
    ];
    const capability = payload.capability;
    const isSsh = capability === "ssh.exec";
    if (!exactKeys(payload, isSsh ? [...keys, "resource"] : keys)
      || payload.integrationId !== "tailscale"
      || payload.credentialId !== "auth-key"
      || !TAILSCALE_CAPABILITIES.has(capability)
      || (isSsh && (typeof payload.resource !== "string" || !TAILSCALE_PEER_ID.test(payload.resource)))) {
      throw new Error("Integration capability denied");
    }
    const value = await this.currentMaterial({ integrationId: "tailscale", credentialId: "auth-key" });
    if (!value || !value.startsWith("tskey-auth-")) throw new Error("Integration credential unavailable");
    return { authorized: true, expiresAt: this.now() + AUTHORIZATION_LIFETIME_MS };
  }
}

export const integrationCredentialLeaseBroker = new IntegrationCredentialLeaseBroker({
  githubCredential: async (accountId) => {
    const { resolveActiveGithubCredentialForWorker } = await import("../app/services/github-integration-service.js");
    return resolveActiveGithubCredentialForWorker(accountId);
  },
  tailscaleAuthKey: async (credentialId) => {
    const { resolveTailscaleAuthKey } = await import("../app/services/tailscale-integration-service.js");
    return resolveTailscaleAuthKey(credentialId);
  },
});

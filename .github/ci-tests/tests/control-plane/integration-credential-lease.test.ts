import { describe, expect, it } from "vitest";
import { IntegrationCredentialLeaseBroker } from "../../src/control-plane/integration-credential-lease.js";

const owner = {
  nodeId: "worker-a",
  generation: 3,
  chatId: -100123,
  threadId: 42,
  sessionId: "session-a",
};

function claims(overrides: Record<string, unknown> = {}) {
  return {
    workerId: owner.nodeId,
    topicId: `${owner.chatId}:${owner.threadId}`,
    generation: owner.generation,
    sessionId: owner.sessionId,
    ...overrides,
  };
}

describe("Topic Worker integration credential leases", () => {
  it("leases only the active GitHub account for its exact repository capability", async () => {
    let token = "github-token-current";
    let now = 1_000;
    let nextId = 0;
    const broker = new IntegrationCredentialLeaseBroker({
      githubCredential: async (accountId) => accountId === "amin" ? token : null,
      tailscaleAuthKey: async () => null,
      now: () => now,
      leaseId: () => `lease-${++nextId}`,
    });
    const request = {
      ...claims(),
      integrationId: "github",
      credentialId: "amin",
      capability: "repo.read",
      scopes: ["repo.read"],
      resource: "amin/private-repo",
    };

    const issued = await broker.acquire(request, owner);
    expect(issued).toEqual({ value: token, leaseId: "lease-1", expiresAt: 56_000 });
    expect(await broker.validate({ leaseId: issued.leaseId }, owner)).toEqual({ valid: true });

    token = "github-token-rotated";
    expect(await broker.validate({ leaseId: issued.leaseId }, owner)).toEqual({ valid: false });
    await expect(broker.acquire({ ...request, credentialId: "other" }, owner)).rejects.toThrow(/unavailable/i);
    await expect(broker.acquire({ ...request, scopes: ["repo.read", "repo.write"] }, owner)).rejects.toThrow(/denied/i);
    await expect(broker.acquire({ ...request, resource: "https://github.com/amin/private-repo" }, owner)).rejects.toThrow(/denied/i);

    expect(await broker.release({ leaseId: issued.leaseId }, owner)).toEqual({ released: true });
    expect(await broker.validate({ leaseId: issued.leaseId }, owner)).toEqual({ valid: false });
    expect(now).toBe(1_000);
  });

  it("fences credentials to the exact Worker, Topic, generation, and session", async () => {
    const broker = new IntegrationCredentialLeaseBroker({
      githubCredential: async () => "github-token-current",
      tailscaleAuthKey: async () => null,
      now: () => 5_000,
      leaseId: () => "lease-topic-a",
    });
    const request = {
      ...claims(),
      integrationId: "github",
      credentialId: "amin",
      capability: "repo.write",
      scopes: ["repo.write"],
      resource: "amin/private-repo",
    };

    const issued = await broker.acquire(request, owner);
    const foreignOwner = { ...owner, threadId: 43 };
    expect(await broker.validate({ leaseId: issued.leaseId }, foreignOwner)).toEqual({ valid: false });
    await expect(broker.acquire(request, foreignOwner)).rejects.toThrow(/denied/i);
    await expect(broker.acquire({ ...request, ...claims({ generation: 2 }) }, owner)).rejects.toThrow(/denied/i);
  });

  it("authorizes only supported Tailscale actions and requires an opaque SSH peer id", async () => {
    const broker = new IntegrationCredentialLeaseBroker({
      githubCredential: async () => null,
      tailscaleAuthKey: async (credentialId) => credentialId === "auth-key" ? "tskey-auth-worker" : null,
      now: () => 10_000,
      leaseId: () => "lease-tailnet",
    });
    const enrollment = await broker.acquire({
      ...claims(),
      integrationId: "tailscale",
      credentialId: "auth-key",
      capability: "device.enroll",
      scopes: ["device.enroll"],
    }, owner);
    expect(enrollment.value).toBe("tskey-auth-worker");
    expect(await broker.authorize({
      ...claims(),
      integrationId: "tailscale",
      credentialId: "auth-key",
      capability: "ssh.exec",
      scopes: ["ssh.exec"],
      resource: "peer_123",
    }, owner)).toEqual({ authorized: true, expiresAt: 20_000 });
    await expect(broker.authorize({
      ...claims(),
      integrationId: "tailscale",
      credentialId: "auth-key",
      capability: "ssh.exec",
      scopes: ["ssh.exec"],
      resource: "100.64.0.1",
    }, owner)).rejects.toThrow(/denied/i);
    await expect(broker.authorize({
      ...claims(),
      integrationId: "tailscale",
      credentialId: "auth-key",
      capability: "admin",
      scopes: ["admin"],
    }, owner)).rejects.toThrow(/denied/i);
  });

  it("expires leases and rejects forged claim fields", async () => {
    let now = 20_000;
    const broker = new IntegrationCredentialLeaseBroker({
      githubCredential: async () => "github-token-current",
      tailscaleAuthKey: async () => null,
      now: () => now,
      leaseId: () => "lease-expiring",
    });
    const request = {
      ...claims(),
      integrationId: "github",
      credentialId: "amin",
      capability: "repo.read",
      scopes: ["repo.read"],
      resource: "amin/private-repo",
    };
    const issued = await broker.acquire(request, owner);

    await expect(broker.acquire({ ...request, workerId: "worker-b" }, owner)).rejects.toThrow(/denied/i);
    await expect(broker.acquire({ ...request, unexpected: true }, owner)).rejects.toThrow(/denied/i);
    now = issued.expiresAt;
    expect(await broker.validate({ leaseId: issued.leaseId }, owner)).toEqual({ valid: false });
  });
});

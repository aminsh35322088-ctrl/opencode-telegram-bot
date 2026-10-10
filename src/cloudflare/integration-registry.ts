import { CapabilityRegistry } from "./capability-broker.js";

export function createIntegrationRegistry(
  providerIds: string[] = [],
  mcpIds: string[] = [],
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register({
    id: "github",
    credentialType: "personal-access-token",
    capabilities: ["repo.read", "repo.write"],
    requiredScopes: { "repo.read": ["repo.read"], "repo.write": ["repo.write"] },
    runtime: "core",
    persistentState: false,
    processLifecycle: true,
  });
  registry.register({
    id: "tailscale",
    credentialType: "management-or-enrollment-key",
    capabilities: ["device.enroll", "network.status", "network.devices", "ssh.exec"],
    requiredScopes: {
      "device.enroll": ["device.enroll"],
      "network.status": ["network.status"],
      "network.devices": ["network.devices"],
      "ssh.exec": ["ssh.exec"],
    },
    runtime: "core",
    persistentState: true,
    processLifecycle: true,
  });
  for (const [kind, ids] of [
    ["provider", providerIds],
    ["mcp", mcpIds],
  ] as const) {
    for (const id of ids) {
      const capability = kind + ".request";
      registry.register({
        id: kind + ":" + id,
        credentialType: kind === "mcp" ? "http-headers-json" : "api-key",
        capabilities: [capability],
        requiredScopes: { [capability]: [capability] },
        runtime: "core",
        persistentState: false,
        processLifecycle: kind === "mcp",
      });
    }
  }
  return registry;
}

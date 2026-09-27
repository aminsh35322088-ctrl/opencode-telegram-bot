import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: {
      token: "telegram-extension-test-token",
      allowedUserId: 1,
      proxyUrl: "",
      apiRoot: "",
      proxySecret: "",
      forceIpv4: false,
    },
    opencode: {
      apiUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "",
      autoRestartEnabled: false,
      monitorIntervalSec: 20,
      model: { provider: "opencode", modelId: "test-model" },
    },
  },
}));

import {
  getExtensionCredentialStatus,
  resolveExtensionCredential,
  saveExtensionCredential,
} from "../../../src/app/services/credential-vault-service.js";
import { listStoredExtensions, saveStoredExtension } from "../../../src/app/services/extension-store.js";
import { extensionId } from "../../../src/app/services/extension-registry-service.js";
import {
  listGeneratedActions,
  registerGeneratedActionPack,
  setGeneratedActionEnabled,
} from "../../../src/app/services/generated-action-store.js";
import {
  bindSecureCredentialChallenge,
  createSecureCredentialChallenge,
  getSecureCredentialChallenge,
  submitSecureCredential,
} from "../../../src/app/services/secure-credential-broker.js";
import {
  getProviderFreePolicy,
  setProviderFreePolicy,
} from "../../../src/app/services/provider-free-policy-service.js";

const extension = {
  id: "mcp:graphify",
  name: "Graphify",
  kind: "mcp" as const,
  source: "https://mcp.example.com/",
  purpose: "Repository graph analysis",
  authType: "bearer" as const,
  credentialSchemas: [{
    id: "bearer",
    label: "Bearer token",
    type: "bearer" as const,
    transport: { kind: "authorization-bearer" as const },
  }],
  resource: { kind: "mcp" as const, serverName: "graphify", projectDirectory: "/work/repo" },
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  managed: true,
};

describe("extension architecture persistence", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "extension-architecture-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    await saveStoredExtension(extension);
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("encrypts generic Extension credentials at rest", async () => {
    await saveExtensionCredential(extension.id, "bearer", "ext-super-secret");

    expect(await getExtensionCredentialStatus(extension.id, "bearer")).toBe("configured");
    expect(await resolveExtensionCredential(extension.id, "bearer")).toBe("ext-super-secret");

    const raw = await fs.readFile(path.join(home, "app-state.json"), "utf8");
    expect(raw).not.toContain("ext-super-secret");
  });

  it("binds one-time secure input to chat, Topic, and Telegram user", async () => {
    const challenge = await createSecureCredentialChallenge({
      extensionId: extension.id,
      credentialId: "bearer",
      sessionId: "ses_graphify",
      projectDirectory: "/work/repo",
    });

    bindSecureCredentialChallenge(challenge.challengeId, 100, 7, 42);
    await expect(
      submitSecureCredential(challenge.challengeId, 100, 7, 99, "wrong-user-secret"),
    ).rejects.toThrow(/scope/i);
    await expect(
      submitSecureCredential(challenge.challengeId, 100, 7, 42, "scoped-secret"),
    ).resolves.toMatchObject({ extensionId: extension.id, used: true });
    expect(getSecureCredentialChallenge(challenge.challengeId)).toBeNull();
    expect(await resolveExtensionCredential(extension.id, "bearer")).toBe("scoped-secret");
  });

  it("keeps user-disabled generated actions disabled across regeneration", async () => {
    const first = await registerGeneratedActionPack(extension.id, [{
      id: "graphify.graph.status",
      tool: "graphify_graph_status",
      description: "Read graph status.",
    }, {
      id: "graphify.graph.delete",
      tool: "graphify_graph_delete",
      description: "Delete a graph snapshot.",
    }, {
      id: "graphify.graph.run",
      tool: "graphify_graph_run",
      description: "Run a provider-defined graph operation.",
    }]);

    expect(first.find((item) => item.id === "graphify.graph.status")?.risk).toBe("read");
    expect(first.find((item) => item.id === "graphify.graph.delete")?.risk).toBe("destructive");
    expect(first.find((item) => item.id === "graphify.graph.run")?.risk).toBe("external");

    await setGeneratedActionEnabled("graphify.graph.status", false);
    const regenerated = await registerGeneratedActionPack(extension.id, [{
      id: "graphify.graph.status",
      tool: "graphify_graph_status_v2",
      description: "Read graph status after provider refresh.",
    }]);
    expect(regenerated[0]?.enabled).toBe(false);
    expect(regenerated[0]?.userDisabled).toBe(true);
    expect((await listGeneratedActions(extension.id)).find((item) => item.id === "graphify.graph.status")?.tool).toBe("graphify_graph_status_v2");
  });

  it("scopes MCP Extension identity by project directory", async () => {
    const firstId = extensionId("mcp", "graphify", "/work/repo-a");
    const secondId = extensionId("mcp", "graphify", "/work/repo-b");
    expect(firstId).not.toBe(secondId);

    await saveStoredExtension({
      ...extension,
      id: firstId,
      resource: { kind: "mcp", serverName: "graphify", projectDirectory: "/work/repo-a" },
    });
    await saveStoredExtension({
      ...extension,
      id: secondId,
      resource: { kind: "mcp", serverName: "graphify", projectDirectory: "/work/repo-b" },
    });

    const ids = (await listStoredExtensions()).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([firstId, secondId]));
  });

  it("persists provider-level free-model policy separately from model discovery", async () => {
    await setProviderFreePolicy({
      providerId: "example-provider",
      freeSuffix: ":free",
      freeModels: ["model-a"],
      paidByDefault: true,
      confidence: "high",
      source: "https://provider.example/pricing",
    });

    await expect(getProviderFreePolicy("example-provider")).resolves.toMatchObject({
      freeSuffix: ":free",
      freeModels: ["model-a"],
      confidence: "high",
    });
  });
});

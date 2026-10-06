import { runTrustedTelegramGlobalMutation } from "../../../src/control-plane/mutations.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: { token: "123456:persistent-cleanup-test", allowedUserId: 1 },
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

import { cleanupLegacyUserConfiguration } from "../../../src/app/services/persistent-state-registry.js";
import { readAppState, updateAppState } from "../../../src/app/stores/app-state-store.js";
import {
  getExtensionCredentialStatus,
  saveExtensionCredential,
} from "../../../src/app/services/credential-vault-service.js";
import {
  listStoredExtensions,
  saveStoredExtension,
} from "../../../src/app/services/extension-store.js";
import {
  listGeneratedActions,
  registerGeneratedActionPack as rawRegisterGeneratedActionPack,
} from "../../../src/app/services/generated-action-store.js";

describe("removed OmniRouter and automatic Extension state cleanup", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "removed-extension-cleanup-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    process.env.HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    delete process.env.HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("purges retired free-source and model-chat Extension artifacts only", async () => {
    const omniDir = path.join(home, "omnirouter");
    await fs.mkdir(omniDir, { recursive: true });
    await fs.writeFile(path.join(omniDir, "omnirouter.json"), "legacy-omni-secret");

    await updateAppState({
      settings: {
        experimentalFreeModelDetection: true,
        experimentalFreeModelSources: true,
      },
      freeModelSources: { qwenToken: "legacy-qwen-token" },
      freeModelSourcesRuntime: { routerKey: "legacy-router-key" },
      integrations: {
        railway: { token: "legacy-railway-token" },
        tailscale: { configured: true },
      },
    });

    const now = "2026-09-28T00:00:00.000Z";
    await saveStoredExtension({
      id: "mcp:graphify:legacy",
      name: "Graphify",
      kind: "mcp",
      source: "https://graphify.example/mcp",
      authType: "bearer",
      credentialSchemas: [],
      resource: { kind: "mcp", serverName: "graphify", projectDirectory: "/work/repo" },
      createdAt: now,
      updatedAt: now,
      managed: true,
    });
    await saveStoredExtension({
      id: "model-provider:custom",
      name: "Custom",
      kind: "model-provider",
      source: "https://provider.example/v1",
      authType: "api-key",
      credentialSchemas: [],
      resource: { kind: "model-provider", providerId: "custom" },
      createdAt: now,
      updatedAt: now,
      managed: true,
    });
    await saveStoredExtension({
      id: "skill:deploy-check",
      name: "deploy-check",
      kind: "skill",
      source: "https://github.com/example/deploy-check",
      authType: "none",
      credentialSchemas: [],
      resource: { kind: "skill", skillName: "deploy-check" },
      createdAt: now,
      updatedAt: now,
      managed: true,
    });

    await saveExtensionCredential("internal:omnirouter", "router-key", "omni-vault-secret");
    await saveExtensionCredential("integration:free-model-source:qwen", "credential", "qwen-vault-secret");
    await saveExtensionCredential("mcp:graphify:legacy", "credential", "graphify-vault-secret");
    await saveExtensionCredential("model-provider:custom", "api-key", "provider-secret");

    await registerGeneratedActionPack("mcp:graphify:legacy", [{
      id: "graphify.query",
      tool: "graphify_query",
      description: "Query Graphify.",
      invocation: { kind: "mcp-tool", server: "graphify", tool: "graphify_query" },
    }]);
    await registerGeneratedActionPack("skill:deploy-check", [{
      id: "deploy.check.load",
      tool: "skill",
      action: "load",
      description: "Load deploy-check.",
      invocation: { kind: "native-tool", tool: "skill", arguments: { name: "deploy-check" } },
    }]);

    await cleanupLegacyUserConfiguration();

    await expect(fs.stat(omniDir)).rejects.toMatchObject({ code: "ENOENT" });
    const state = await readAppState();
    expect(state).not.toHaveProperty("freeModelSources");
    expect(state).not.toHaveProperty("freeModelSourcesRuntime");
    expect(state.settings).toMatchObject({ experimentalFreeModelDetection: true });
    expect(state.settings).not.toHaveProperty("experimentalFreeModelSources");
    expect(state.integrations).toEqual({ tailscale: { configured: true } });

    expect((await listStoredExtensions()).map((item) => item.id)).toEqual(["skill:deploy-check"]);
    expect((await listGeneratedActions()).map((item) => item.id)).toEqual(["deploy.check.load"]);

    await expect(getExtensionCredentialStatus("internal:omnirouter", "router-key")).resolves.toBe("missing");
    await expect(getExtensionCredentialStatus("integration:free-model-source:qwen", "credential")).resolves.toBe("missing");
    await expect(getExtensionCredentialStatus("mcp:graphify:legacy", "credential")).resolves.toBe("missing");

    // Custom-provider credentials belong to the manual provider configuration,
    // not the retired automatic Extension registry.
    await expect(getExtensionCredentialStatus("model-provider:custom", "api-key")).resolves.toBe("configured");

    const current = await fs.readFile(path.join(home, "app-state.json"), "utf8");
    const backup = await fs.readFile(path.join(home, "app-state.json.bak"), "utf8");
    for (const retiredSecret of [
      "legacy-omni-secret",
      "legacy-qwen-token",
      "legacy-router-key",
      "legacy-railway-token",
      "omni-vault-secret",
      "qwen-vault-secret",
      "graphify-vault-secret",
    ]) {
      expect(current).not.toContain(retiredSecret);
      expect(backup).not.toContain(retiredSecret);
    }
  });
});

// Fixtures model an explicit approved Telegram UI pack operation.
const registerGeneratedActionPack = (...args: Parameters<typeof rawRegisterGeneratedActionPack>) => runTrustedTelegramGlobalMutation("generated-actions.register", args[0], () => rawRegisterGeneratedActionPack(...args));

import { runTrustedTelegramGlobalMutation } from "../../../src/control-plane/mutations.js";
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
import { saveStoredExtension } from "../../../src/app/services/extension-store.js";
import {
  listGeneratedActions,
  registerGeneratedActionPack,
  setGeneratedActionEnabled as rawSetGeneratedActionEnabled,
} from "../../../src/app/services/generated-action-store.js";
import {
  getProviderFreePolicy,
  setProviderFreePolicy,
} from "../../../src/app/services/provider-free-policy-service.js";

const extension = {
  id: "plugin:example-plugin",
  name: "Example Plugin",
  kind: "plugin" as const,
  source: "example-plugin@1.0.0",
  purpose: "Test plugin persistence",
  authType: "none" as const,
  credentialSchemas: [],
  resource: { kind: "plugin" as const, specifier: "example-plugin@1.0.0" },
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  managed: true,
};

// These fixtures represent explicit Telegram UI service callers; raw exports remain guarded.
const setGeneratedActionEnabled = (...args: Parameters<typeof rawSetGeneratedActionEnabled>) => runTrustedTelegramGlobalMutation("generated-actions.toggle", args[0], () => rawSetGeneratedActionEnabled(...args));

describe("retained Extension and Actions persistence", () => {
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

  it("keeps generic Extension secrets encrypted at rest", async () => {
    await saveExtensionCredential(extension.id, "future-secret", "ext-super-secret");
    expect(await getExtensionCredentialStatus(extension.id, "future-secret")).toBe("configured");
    expect(await resolveExtensionCredential(extension.id, "future-secret")).toBe("ext-super-secret");

    const raw = await fs.readFile(path.join(home, "app-state.json"), "utf8");
    expect(raw).not.toContain("ext-super-secret");
  });

  it("keeps user-disabled generated actions disabled across regeneration", async () => {
    const first = await registerGeneratedActionPack(extension.id, [{
      id: "example.plugin.inspect",
      tool: "example_inspect",
      description: "Inspect plugin state.",
    }, {
      id: "example.plugin.delete",
      tool: "example_delete",
      description: "Delete plugin state.",
    }]);

    expect(first.find((item) => item.id === "example.plugin.inspect")?.risk).toBe("read");
    expect(first.find((item) => item.id === "example.plugin.delete")?.risk).toBe("destructive");

    await setGeneratedActionEnabled("example.plugin.inspect", false);
    const regenerated = await registerGeneratedActionPack(extension.id, [{
      id: "example.plugin.inspect",
      tool: "example_inspect_v2",
      description: "Inspect refreshed plugin state.",
    }]);
    expect(regenerated[0]?.enabled).toBe(false);
    expect(regenerated[0]?.userDisabled).toBe(true);
    expect(
      (await listGeneratedActions(extension.id))
        .find((item) => item.id === "example.plugin.inspect")?.tool,
    ).toBe("example_inspect_v2");
  });

  it("persists provider free-model policy independently", async () => {
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

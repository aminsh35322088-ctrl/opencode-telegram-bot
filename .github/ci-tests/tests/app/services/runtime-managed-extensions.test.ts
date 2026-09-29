import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: {
      token: "runtime-extension-test-token",
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
  migrateBundledExtensionsToManagedState,
  SUPERPOWERS_EXTENSION_ID,
  SUPERPOWERS_PLUGIN_SPECIFIER,
} from "../../../src/app/services/extension-defaults-service.js";
import {
  getStoredExtension,
  removeStoredExtension,
  saveStoredExtension,
} from "../../../src/app/services/extension-store.js";
import {
  syncOpenCodeCustomConfig,
} from "../../../src/app/services/custom-provider-service.js";
import {
  validatePluginSpecifier,
} from "../../../src/app/services/extension-ensure-service.js";

describe("runtime-managed Extensions", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-managed-extensions-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    delete process.env.OPENCODE_CONFIG;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("migrates bundled Superpowers to bot-owned state exactly once", async () => {
    await expect(migrateBundledExtensionsToManagedState()).resolves.toEqual({ seeded: 1 });
    const stored = await getStoredExtension(SUPERPOWERS_EXTENSION_ID);

    expect(stored).toMatchObject({
      id: "plugin:superpowers",
      kind: "plugin",
      source: SUPERPOWERS_PLUGIN_SPECIFIER,
      resource: { kind: "plugin", specifier: SUPERPOWERS_PLUGIN_SPECIFIER },
    });
    expect(SUPERPOWERS_PLUGIN_SPECIFIER).toContain("#v6.4.2");

    await removeStoredExtension(SUPERPOWERS_EXTENSION_ID);
    await expect(migrateBundledExtensionsToManagedState()).resolves.toEqual({ seeded: 0 });
    await expect(getStoredExtension(SUPERPOWERS_EXTENSION_ID)).resolves.toBeNull();
  });
  it("materializes plugins only into the bot-owned managed OpenCode overlay", async () => {
    await saveStoredExtension({
      id: "plugin:example",
      name: "Example",
      kind: "plugin",
      source: "example-plugin@1.2.3",
      purpose: "test",
      authType: "none",
      credentialSchemas: [],
      resource: { kind: "plugin", specifier: "example-plugin@1.2.3" },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    });

    const configPath = await syncOpenCodeCustomConfig();
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      plugin?: string[];
      permission?: Record<string, unknown>;
    };

    expect(configPath).toBe(
      path.join(home, ".config", "opencode-telegram", "managed-opencode.json"),
    );
    expect(config.plugin).toEqual(["example-plugin@1.2.3"]);

    await expect(fs.readFile(path.resolve("opencode.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts pinned plugins and rejects repo-local or floating plugin sources", () => {
    expect(validatePluginSpecifier(SUPERPOWERS_PLUGIN_SPECIFIER))
      .toBe(SUPERPOWERS_PLUGIN_SPECIFIER);
    expect(validatePluginSpecifier("@scope/plugin@1.2.3")).toBe("@scope/plugin@1.2.3");
    expect(() => validatePluginSpecifier("plugin@latest")).toThrow(/pin|version/i);
    expect(() => validatePluginSpecifier("plugin@beta")).toThrow(/pin|version/i);
    expect(() => validatePluginSpecifier("plugin@^1.2.3")).toThrow(/pin|version/i);
    expect(() => validatePluginSpecifier("file:./plugin")).toThrow(/filesystem/i);
    expect(() => validatePluginSpecifier("./plugin")).toThrow(/filesystem/i);
    expect(() => validatePluginSpecifier(
      "plugin@git+https://github.com/example/plugin.git",
    )).toThrow(/explicit tag|commit|ref/i);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reload: vi.fn(async () => {}),
}));

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: { token: "plugin-update-test-token", allowedUserId: 1 },
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

vi.mock("../../../src/app/services/opencode-managed-config-service.js", () => ({
  reloadManagedOpenCodeConfig: mocks.reload,
}));

vi.mock("../../../src/app/services/extension-registry-service.js", () => ({
  extensionId: (kind: string, name: string) =>
    kind + ":" + name.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-"),
  listExtensions: vi.fn(async () => [{
    id: "plugin:superpowers",
    name: "Superpowers",
    kind: "plugin",
    source: "superpowers@git+https://github.com/obra/superpowers.git#v6.3.0",
    authType: "none",
    status: "ready",
    managed: true,
  }]),
}));

import {
  approveExtensionEnsure,
  requestExtensionEnsure,
} from "../../../src/app/services/extension-ensure-service.js";
import {
  getStoredExtension,
  saveStoredExtension,
} from "../../../src/app/services/extension-store.js";

describe("plugin Extension update lifecycle", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-extension-update-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    mocks.reload.mockClear();

    await saveStoredExtension({
      id: "plugin:superpowers",
      name: "Superpowers",
      kind: "plugin",
      source: "superpowers@git+https://github.com/obra/superpowers.git#v6.3.0",
      purpose: "skills",
      authType: "none",
      credentialSchemas: [],
      resource: {
        kind: "plugin",
        specifier: "superpowers@git+https://github.com/obra/superpowers.git#v6.3.0",
      },
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      managed: true,
    });
  });
  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("routes a version change through approval and bot-owned runtime reload", async () => {
    const requested = await requestExtensionEnsure({
      sessionId: "session-a",
      projectDirectory: "/workspace/topic-a",
      name: "Superpowers",
      kind: "plugin",
      source: "superpowers@git+https://github.com/obra/superpowers.git#v6.4.2",
      purpose: "Update reusable development skills",
    });

    expect(requested.status).toBe("approval-required");
    expect(requested.requestId).toBeTypeOf("string");

    const approved = await approveExtensionEnsure(requested.requestId!);
    expect(approved.status).toBe("ready");
    expect(mocks.reload).toHaveBeenCalledWith(
      "extension_plugin_change",
      { timeoutMs: 30_000 },
    );

    const stored = await getStoredExtension("plugin:superpowers");
    expect(stored?.source).toContain("#v6.4.2");
    expect(stored?.resource).toEqual({
      kind: "plugin",
      specifier: "superpowers@git+https://github.com/obra/superpowers.git#v6.4.2",
    });
    expect(stored?.createdAt).toBe("2026-09-20T00:00:00.000Z");
  });
});

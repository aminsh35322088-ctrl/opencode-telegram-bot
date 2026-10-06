import { runTrustedTelegramGlobalMutation } from "../../../src/control-plane/mutations.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateExtensionActions } from "../../../src/app/services/extension-action-generator-service.js";
import { listGeneratedActions } from "../../../src/app/services/generated-action-store.js";
import { saveStoredExtension } from "../../../src/app/services/extension-store.js";

describe("automatic Skill Action generation", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "extension-actions-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("creates a deterministic native skill.load action", async () => {
    const extension = {
      id: "skill:deploy-check",
      name: "deploy-check",
      kind: "skill" as const,
      source: "https://github.com/example/skills/deploy-check",
      purpose: "Check deployments",
      authType: "none" as const,
      credentialSchemas: [],
      resource: { kind: "skill" as const, skillName: "deploy-check" },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    };
    await saveStoredExtension(extension);

    await expect(runTrustedTelegramGlobalMutation("skills.add", extension.resource.skillName, () => generateExtensionActions(extension))).resolves.toBe(1);
    await expect(listGeneratedActions(extension.id)).resolves.toEqual([
      expect.objectContaining({
        id: "deploy.check.load",
        tool: "skill",
        action: "load",
        category: "skill",
        invocation: {
          kind: "native-tool",
          tool: "skill",
          arguments: { name: "deploy-check" },
        },
      }),
    ]);
  });

  it("does not auto-generate Actions for non-Skill Extensions", async () => {
    const extension = {
      id: "plugin:example",
      name: "Example",
      kind: "plugin" as const,
      source: "example-plugin@1.0.0",
      purpose: "Example plugin",
      authType: "none" as const,
      credentialSchemas: [],
      resource: { kind: "plugin" as const, specifier: "example-plugin@1.0.0" },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    };

    await expect(generateExtensionActions(extension)).resolves.toBe(0);
    await expect(listGeneratedActions(extension.id)).resolves.toEqual([]);
  });
});

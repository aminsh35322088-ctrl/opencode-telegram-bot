import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSharedExtensionAutomationState,
  listSharedCredentialChallenges,
  readSharedCredentialChallenge,
  readSharedPendingOAuth,
  removeSharedCredentialChallenge,
  removeSharedPendingOAuth,
  writeSharedCredentialChallenge,
  writeSharedPendingOAuth,
} from "../../../src/app/services/extension-automation-state-store.js";

describe("shared Extension automation state", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "extension-automation-state-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    clearSharedExtensionAutomationState();
  });

  afterEach(async () => {
    clearSharedExtensionAutomationState();
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("persists OAuth state on disk so OpenCode and Bot processes can share it", () => {
    writeSharedPendingOAuth({
      sessionId: "ses-cross-process",
      extensionId: "mcp:graphify",
      projectDirectory: "/work/repo",
      serverName: "graphify",
      oauthState: "oauth-state",
      authorizationUrl: "https://graphify.example/oauth",
      expiresAt: Date.now() + 60_000,
    });

    expect(readSharedPendingOAuth("ses-cross-process")).toMatchObject({
      sessionId: "ses-cross-process",
      extensionId: "mcp:graphify",
      oauthState: "oauth-state",
    });

    removeSharedPendingOAuth("ses-cross-process");
    expect(readSharedPendingOAuth("ses-cross-process")).toBeNull();
  });

  it("persists secure credential challenges without storing the credential value", async () => {
    writeSharedCredentialChallenge({
      id: "challenge-1",
      extensionId: "mcp:private",
      credentialId: "api-key",
      sessionId: "ses-1",
      projectDirectory: "/work/repo",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      used: false,
    });

    expect(readSharedCredentialChallenge("challenge-1")).toMatchObject({
      extensionId: "mcp:private",
      credentialId: "api-key",
    });
    expect(listSharedCredentialChallenges()).toHaveLength(1);

    const raw = await fs.readFile(
      path.join(home, "run", "extension-automation", "credentials", "challenge-1.json"),
      "utf8",
    );
    expect(raw).not.toMatch(/secret|api[-_ ]?key["']?\s*:/i);

    removeSharedCredentialChallenge("challenge-1");
    expect(readSharedCredentialChallenge("challenge-1")).toBeNull();
  });
});

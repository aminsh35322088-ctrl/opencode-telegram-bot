import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claimSharedPendingAdd,
  clearSharedExtensionAutomationState,
  readSharedPendingAdd,
  removeSharedPendingAdd,
  writeSharedPendingAdd,
} from "../../../src/app/services/extension-automation-state-store.js";

describe("shared Skill automation state", () => {
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

  it("persists and atomically claims a pending Skill add intent", async () => {
    const intent = {
      sessionId: "ses-cross-process",
      projectDirectory: "/work/repo",
      kind: "skill" as const,
      source: "https://github.com/example/skills/tree/main/deploy-check",
      purpose: "Install deploy-check",
      question: { header: "Add Skill", question: "Add deploy-check?" },
      choices: [{ label: "Add", action: "add" as const }],
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    writeSharedPendingAdd(intent);
    expect(readSharedPendingAdd("ses-cross-process")).toMatchObject({
      sessionId: "ses-cross-process",
      kind: "skill",
      source: intent.source,
    });

    expect(claimSharedPendingAdd("ses-cross-process")).toMatchObject({
      sessionId: "ses-cross-process",
      kind: "skill",
    });
    expect(readSharedPendingAdd("ses-cross-process")).toBeNull();
  });

  it("removes pending Skill add state cleanly", () => {
    writeSharedPendingAdd({
      sessionId: "ses-remove",
      projectDirectory: "/work/repo",
      kind: "skill",
      source: "https://github.com/example/skills",
      purpose: "Select a Skill",
      question: { header: "Choose Skill", question: "Choose one" },
      choices: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    removeSharedPendingAdd("ses-remove");
    expect(readSharedPendingAdd("ses-remove")).toBeNull();
  });
});

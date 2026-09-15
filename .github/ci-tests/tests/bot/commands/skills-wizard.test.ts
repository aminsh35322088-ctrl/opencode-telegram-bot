import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context } from "grammy";

const pathsMock = vi.hoisted(() => ({ appHome: "" }));

vi.mock("../../../src/runtime/paths.js", () => ({
  getRuntimePaths: () => ({ appHome: pathsMock.appHome }),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  clearSkillWizard,
  handleSkillWizardMessage,
  isSkillWizardActive,
  startSkillEdit,
  startSkillWizard,
} from "../../../src/bot/commands/skills-wizard.js";
import { writeGlobalSkill } from "../../../src/app/services/skill-manage-service.js";

function ctx(text?: string): { context: Context; replies: string[] } {
  const replies: string[] = [];
  const context = {
    message: text === undefined ? undefined : { text },
    reply: vi.fn(async () => {
      replies.push(text ?? "");
      return { message_id: 1 };
    }),
  } as unknown as Context;
  return { context, replies };
}

describe("bot/commands/skills-wizard", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "otb-wizard-"));
    pathsMock.appHome = tmpHome;
    clearSkillWizard();
  });

  afterEach(async () => {
    clearSkillWizard();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("runs the three-step wizard and writes the skill", async () => {
    const start = ctx();
    await startSkillWizard(start.context);
    expect(isSkillWizardActive()).toBe(true);

    expect(await handleSkillWizardMessage(ctx("Bad Name").context)).toBe(true);
    expect(isSkillWizardActive()).toBe(true);

    expect(await handleSkillWizardMessage(ctx("deploy-check").context)).toBe(true);
    expect(await handleSkillWizardMessage(ctx("Use before deploys").context)).toBe(true);
    expect(await handleSkillWizardMessage(ctx("# Steps\n1. run tests").context)).toBe(true);

    expect(isSkillWizardActive()).toBe(false);
    const content = await fs.readFile(path.join(tmpHome, ".config", "opencode", "skills", "deploy-check", "SKILL.md"), "utf8");
    expect(content).toContain("name: deploy-check");
    expect(content).toContain("# Steps");
  });

  it("ignores text when inactive and ignores commands/slash text", async () => {
    expect(await handleSkillWizardMessage(ctx("hello").context)).toBe(false);
    await startSkillWizard(ctx().context);
    expect(await handleSkillWizardMessage(ctx("/cancel").context)).toBe(false);
    expect(isSkillWizardActive()).toBe(true);
  });

  it("edits an existing skill without a name step", async () => {
    await writeGlobalSkill({ name: "deploy-check", description: "old desc", body: "# Old" });

    const start = ctx();
    await startSkillEdit(start.context, "deploy-check");
    expect(isSkillWizardActive()).toBe(true);
    expect(start.context.reply).toHaveBeenCalledTimes(1);

    expect(await handleSkillWizardMessage(ctx("new desc").context)).toBe(true);
    expect(isSkillWizardActive()).toBe(true);
    expect(await handleSkillWizardMessage(ctx("# New body").context)).toBe(true);
    expect(isSkillWizardActive()).toBe(false);

    const content = await fs.readFile(
      path.join(tmpHome, ".config", "opencode", "skills", "deploy-check", "SKILL.md"),
      "utf8",
    );
    expect(content).toContain('description: "new desc"');
    expect(content).toContain("# New body");
    expect(content).not.toContain("# Old");
  });

  it("reports a write error when editing a missing skill and stays active", async () => {
    const start = ctx();
    await startSkillEdit(start.context, "ghost-skill");
    expect(await handleSkillWizardMessage(ctx("desc").context)).toBe(true);
    expect(await handleSkillWizardMessage(ctx("body").context)).toBe(true);
    expect(isSkillWizardActive()).toBe(true);
    await expect(
      fs.stat(path.join(tmpHome, ".config", "opencode", "skills", "ghost-skill", "SKILL.md")),
    ).rejects.toThrow();
    clearSkillWizard();
  });
});

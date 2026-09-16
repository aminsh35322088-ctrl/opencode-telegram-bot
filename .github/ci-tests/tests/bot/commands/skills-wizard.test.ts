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

function panelCtx(messageId = 700): Context {
  return {
    chat: { id: 777 },
    callbackQuery: {
      data: "skills:new",
      message: { message_id: messageId, chat: { id: 777 } },
    } as Context["callbackQuery"],
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

let nextInputId = 800;
function messageCtx(text: string): Context {
  const messageId = nextInputId++;
  return {
    chat: { id: 777 },
    message: { message_id: messageId, text } as Context["message"],
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

describe("bot/commands/skills-wizard", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "otb-wizard-"));
    pathsMock.appHome = tmpHome;
    clearSkillWizard();
    nextInputId = 800;
  });

  afterEach(async () => {
    clearSkillWizard();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("runs the three-step wizard entirely on the existing General panel", async () => {
    const start = panelCtx(700);
    await startSkillWizard(start);

    expect(isSkillWizardActive()).toBe(true);
    expect(start.reply).not.toHaveBeenCalled();
    expect(start.api.editMessageText).toHaveBeenCalledWith(
      777,
      700,
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    const badName = messageCtx("Bad Name");
    expect(await handleSkillWizardMessage(badName)).toBe(true);
    expect(badName.api.deleteMessage).toHaveBeenCalledWith(777, 800);
    expect(badName.api.editMessageText).toHaveBeenCalledWith(
      777,
      700,
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    expect(await handleSkillWizardMessage(messageCtx("deploy-check"))).toBe(true);
    expect(await handleSkillWizardMessage(messageCtx("Use before deploys"))).toBe(true);
    expect(await handleSkillWizardMessage(messageCtx("# Steps\n1. run tests"))).toBe(true);

    expect(isSkillWizardActive()).toBe(false);
    const content = await fs.readFile(path.join(tmpHome, ".config", "opencode", "skills", "deploy-check", "SKILL.md"), "utf8");
    expect(content).toContain("name: deploy-check");
    expect(content).toContain("# Steps");
  });

  it("ignores text when inactive and ignores commands/slash text", async () => {
    expect(await handleSkillWizardMessage(messageCtx("hello"))).toBe(false);
    await startSkillWizard(panelCtx());
    expect(await handleSkillWizardMessage(messageCtx("/cancel"))).toBe(false);
    expect(isSkillWizardActive()).toBe(true);
  });

  it("edits an existing skill without creating a prompt message", async () => {
    await writeGlobalSkill({ name: "deploy-check", description: "old desc", body: "# Old" });

    const start = panelCtx(701);
    await startSkillEdit(start, "deploy-check");
    expect(isSkillWizardActive()).toBe(true);
    expect(start.reply).not.toHaveBeenCalled();
    expect(start.api.editMessageText).toHaveBeenCalledWith(
      777,
      701,
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    expect(await handleSkillWizardMessage(messageCtx("new desc"))).toBe(true);
    expect(isSkillWizardActive()).toBe(true);
    expect(await handleSkillWizardMessage(messageCtx("# New body"))).toBe(true);
    expect(isSkillWizardActive()).toBe(false);

    const content = await fs.readFile(
      path.join(tmpHome, ".config", "opencode", "skills", "deploy-check", "SKILL.md"),
      "utf8",
    );
    expect(content).toContain('description: "new desc"');
    expect(content).toContain("# New body");
    expect(content).not.toContain("# Old");
  });

  it("reports a write error on the same panel and stays active", async () => {
    await startSkillEdit(panelCtx(702), "ghost-skill");
    expect(await handleSkillWizardMessage(messageCtx("desc"))).toBe(true);
    const body = messageCtx("body");
    expect(await handleSkillWizardMessage(body)).toBe(true);
    expect(isSkillWizardActive()).toBe(true);
    expect(body.api.editMessageText).toHaveBeenCalledWith(
      777,
      702,
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    await expect(
      fs.stat(path.join(tmpHome, ".config", "opencode", "skills", "ghost-skill", "SKILL.md")),
    ).rejects.toThrow();
  });
});

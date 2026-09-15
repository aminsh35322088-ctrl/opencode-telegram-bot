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

const serviceMock = vi.hoisted(() => ({
  resolveSkillSource: vi.fn(),
  fetchSkillFromGitHub: vi.fn(),
}));

vi.mock("../../../src/app/services/skill-import-service.js", () => ({
  resolveSkillSource: serviceMock.resolveSkillSource,
  fetchSkillFromGitHub: serviceMock.fetchSkillFromGitHub,
  isAllowedGitHubUrl: vi.fn(() => true),
}));

import {
  clearSkillImportFlow,
  handleSkillImportCallback,
  handleSkillImportMessage,
  isSkillImportActive,
  startSkillImport,
} from "../../../src/bot/commands/skills-import-flow.js";
import { handleSkillWizardMessage, startSkillWizard, clearSkillWizard } from "../../../src/bot/commands/skills-wizard.js";
import { t } from "../../../src/i18n/index.js";

interface Ctx {
  context: Context;
  replies: Array<{ text: string; options?: { reply_markup?: unknown } }>;
  lastKeyboard: () => Array<Array<{ callback_data?: string }>>;
}

function makeCtx(): Ctx {
  const replies: Ctx["replies"] = [];
  const context = {
    message: undefined,
    reply: vi.fn(async (text: string, options?: { reply_markup?: unknown }) => {
      replies.push({ text, options });
      return { message_id: 1 };
    }),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
  return {
    context,
    replies,
    lastKeyboard: () =>
      ((replies[replies.length - 1]?.options?.reply_markup as { inline_keyboard?: unknown } | undefined)
        ?.inline_keyboard ?? []) as Array<Array<{ callback_data?: string }>>,
  };
}

function makeMessage(text: string): Context {
  return {
    message: { text },
    reply: vi.fn().mockResolvedValue({ message_id: 2 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function skill(name: string, description = "desc") {
  return { name, description, content: `---\nname: ${name}\ndescription: ${description}\n---\n\nBody`, sourceUrl: `https://github.com/o/r/tree/main/skills/${name}` };
}

describe("bot/commands/skills-import-flow", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "otb-import-"));
    pathsMock.appHome = tmpHome;
    clearSkillImportFlow();
    clearSkillWizard();
    serviceMock.resolveSkillSource.mockReset();
    serviceMock.fetchSkillFromGitHub.mockReset();
  });

  afterEach(async () => {
    clearSkillImportFlow();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("ignores events while inactive", async () => {
    expect(await handleSkillImportMessage(makeMessage("hello"))).toBe(false);
    expect(await handleSkillImportCallback(makeCtx().context, "skills:imp_confirm")).toBe(true);
    expect(await handleSkillImportCallback(makeCtx().context, "skills:new")).toBe(false);
  });

  it("asks for a link and clears the create wizard when starting", async () => {
    await startSkillWizard(makeCtx().context);
    const ctx = makeCtx();
    await startSkillImport(ctx.context);
    expect(isSkillImportActive()).toBe(true);
    expect(ctx.replies[0]?.text).toBe(t("skills.import.ask_url"));
    expect(ctx.lastKeyboard()[0]?.[0]?.callback_data).toBe("skills:imp_cancel");
    expect(await handleSkillWizardMessage(makeMessage("name"))).toBe(false);
  });

  it("imports a single resolved skill verbatim and finishes", async () => {
    const ctx = makeCtx();
    await startSkillImport(ctx.context);
    serviceMock.resolveSkillSource.mockResolvedValue({ kind: "single", skill: skill("deploy-check", "Check deploys") });

    expect(await handleSkillImportMessage(makeMessage("https://github.com/o/r"))).toBe(true);
    const confirm = ctx.replies[ctx.replies.length - 1];
    expect(confirm?.text).toContain("deploy-check");
    expect(confirm?.text).toContain("Check deploys");
    expect(ctx.lastKeyboard().flat().map((b) => b.callback_data)).toContain("skills:imp_confirm");

    expect(await handleSkillImportCallback(ctx.context, "skills:imp_confirm")).toBe(true);
    expect(isSkillImportActive()).toBe(false);
    const file = path.join(tmpHome, ".config", "opencode", "skills", "deploy-check", "SKILL.md");
    expect(await fs.readFile(file, "utf8")).toContain("Check deploys");
    const last = ctx.replies[ctx.replies.length - 1];
    expect(last?.text).toContain(t("skills.imported", { name: "deploy-check" }));
    expect(last?.text).toContain(t("skills.restart_hint"));
  });

  it("keeps the flow active and reports invalid links", async () => {
    const ctx = makeCtx();
    await startSkillImport(ctx.context);
    serviceMock.resolveSkillSource.mockRejectedValue(new Error("This is not a GitHub link"));
    expect(await handleSkillImportMessage(makeMessage("https://example.com/x"))).toBe(true);
    expect(isSkillImportActive()).toBe(true);
    expect(ctx.replies[ctx.replies.length - 1]?.text).toBe(t("skills.import.invalid_url"));

    serviceMock.resolveSkillSource.mockRejectedValue(new Error("No SKILL.md found in this location"));
    expect(await handleSkillImportMessage(makeMessage("https://github.com/o/r/tree/main/nope"))).toBe(true);
    expect(ctx.replies[ctx.replies.length - 1]?.text).toBe(t("skills.import.not_found"));
  });

  it("walks a multi-skill list one by one", async () => {
    const ctx = makeCtx();
    await startSkillImport(ctx.context);
    serviceMock.resolveSkillSource.mockResolvedValue({
      kind: "list",
      candidates: [
        { name: "alpha", url: "https://github.com/o/r/tree/main/skills/alpha" },
        { name: "beta", url: "https://github.com/o/r/tree/main/skills/beta" },
      ],
    });

    expect(await handleSkillImportMessage(makeMessage("https://github.com/o/r"))).toBe(true);
    expect(ctx.replies[ctx.replies.length - 1]?.text).toContain(t("skills.import.multiple_found"));
    expect(ctx.lastKeyboard().flat().map((b) => b.callback_data)).toEqual([
      "skills:imp_pick:0",
      "skills:imp_pick:1",
      "skills:imp_cancel",
    ]);

    serviceMock.fetchSkillFromGitHub.mockResolvedValue(skill("alpha", "Alpha skill"));
    expect(await handleSkillImportCallback(ctx.context, "skills:imp_pick:0")).toBe(true);
    expect(serviceMock.fetchSkillFromGitHub).toHaveBeenCalledWith(
      "https://github.com/o/r/tree/main/skills/alpha",
      expect.anything(),
    );
    expect(ctx.lastKeyboard().flat().map((b) => b.callback_data)).toContain("skills:imp_confirm");

    expect(await handleSkillImportCallback(ctx.context, "skills:imp_confirm")).toBe(true);
    expect(isSkillImportActive()).toBe(true);
    expect(ctx.replies[ctx.replies.length - 1]?.text).toContain(t("skills.import.multiple_found"));
    expect(ctx.lastKeyboard().flat().map((b) => b.callback_data)).toEqual([
      "skills:imp_pick:0",
      "skills:imp_cancel",
    ]);

    expect(await handleSkillImportCallback(ctx.context, "skills:imp_cancel")).toBe(true);
    expect(isSkillImportActive()).toBe(false);
  });

  it("reports when a skill already exists and stays active", async () => {
    const ctx = makeCtx();
    await startSkillImport(ctx.context);
    serviceMock.resolveSkillSource.mockResolvedValue({ kind: "single", skill: skill("dupe") });
    await handleSkillImportMessage(makeMessage("https://github.com/o/r"));

    await fs.mkdir(path.join(tmpHome, ".config", "opencode", "skills", "dupe"), { recursive: true });
    await fs.writeFile(path.join(tmpHome, ".config", "opencode", "skills", "dupe", "SKILL.md"), "x", "utf8");

    expect(await handleSkillImportCallback(ctx.context, "skills:imp_confirm")).toBe(true);
    expect(isSkillImportActive()).toBe(true);
    expect(ctx.replies[ctx.replies.length - 1]?.text).toBe(t("skills.import.exists", { name: "dupe" }));
  });
});

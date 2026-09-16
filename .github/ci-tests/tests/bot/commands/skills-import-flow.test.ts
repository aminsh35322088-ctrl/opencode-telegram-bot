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

interface PanelEdit {
  text: string;
  options?: { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
}
interface Ctx {
  context: Context;
  edits: PanelEdit[];
  lastKeyboard: () => Array<Array<{ callback_data?: string }>>;
}

function makeCtx(messageId = 700): Ctx {
  const edits: PanelEdit[] = [];
  const recordEdit = vi.fn(async (...args: unknown[]) => {
    const text = typeof args[0] === "number" ? String(args[2] ?? "") : String(args[0] ?? "");
    const options = (typeof args[0] === "number" ? args[3] : args[1]) as PanelEdit["options"];
    edits.push({ text, options });
    return true;
  });
  const context = {
    chat: { id: 777 },
    callbackQuery: {
      data: "skills:import",
      message: { message_id: messageId, chat: { id: 777 } },
    } as Context["callbackQuery"],
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: recordEdit,
    api: {
      editMessageText: recordEdit,
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
  return {
    context,
    edits,
    lastKeyboard: () => edits[edits.length - 1]?.options?.reply_markup?.inline_keyboard ?? [],
  };
}

let nextInputId = 800;
async function sendText(ctx: Ctx, text: string): Promise<boolean> {
  (ctx.context as { message?: { message_id: number; text: string } }).message = {
    message_id: nextInputId++,
    text,
  };
  return handleSkillImportMessage(ctx.context);
}

function makeMessage(text: string): Context {
  return {
    chat: { id: 777 },
    message: { message_id: 990, text } as Context["message"],
    reply: vi.fn().mockResolvedValue({ message_id: 991 }),
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

function skill(name: string, description = "desc") {
  return {
    name,
    description,
    content: `---\nname: ${name}\ndescription: ${description}\n---\n\nBody`,
    sourceUrl: `https://github.com/o/r/tree/main/skills/${name}`,
  };
}

describe("bot/commands/skills-import-flow", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "otb-import-"));
    pathsMock.appHome = tmpHome;
    clearSkillImportFlow();
    clearSkillWizard();
    nextInputId = 800;
    serviceMock.resolveSkillSource.mockReset();
    serviceMock.fetchSkillFromGitHub.mockReset();
  });

  afterEach(async () => {
    clearSkillImportFlow();
    clearSkillWizard();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("ignores events while inactive", async () => {
    expect(await handleSkillImportMessage(makeMessage("hello"))).toBe(false);
    expect(await handleSkillImportCallback(makeCtx().context, "skills:imp_confirm")).toBe(true);
    expect(await handleSkillImportCallback(makeCtx().context, "skills:new")).toBe(false);
  });

  it("edits the General panel for the URL prompt and clears the create wizard", async () => {
    const createCtx = makeCtx(699);
    await startSkillWizard(createCtx.context);
    const ctx = makeCtx(700);
    await startSkillImport(ctx.context);

    expect(isSkillImportActive()).toBe(true);
    expect(ctx.context.reply).not.toHaveBeenCalled();
    expect(ctx.edits[0]?.text).toBe(t("skills.import.ask_url"));
    expect(ctx.lastKeyboard().flat().map((b) => b.callback_data)).toEqual(
      expect.arrayContaining(["skills:imp_cancel", "main:home"]),
    );
    expect(await handleSkillWizardMessage(makeMessage("name"))).toBe(false);
  });

  it("imports a single resolved skill on the same panel and finishes", async () => {
    const ctx = makeCtx();
    await startSkillImport(ctx.context);
    serviceMock.resolveSkillSource.mockResolvedValue({ kind: "single", skill: skill("deploy-check", "Check deploys") });

    expect(await sendText(ctx, "https://github.com/o/r")).toBe(true);
    expect(ctx.edits.at(-1)?.text).toContain("deploy-check");
    expect(ctx.edits.at(-1)?.text).toContain("Check deploys");
    expect(ctx.lastKeyboard().flat().map((b) => b.callback_data)).toContain("skills:imp_confirm");
    expect(ctx.context.api.deleteMessage).toHaveBeenCalledWith(777, 800);

    expect(await handleSkillImportCallback(ctx.context, "skills:imp_confirm")).toBe(true);
    expect(isSkillImportActive()).toBe(false);
    const file = path.join(tmpHome, ".config", "opencode", "skills", "deploy-check", "SKILL.md");
    expect(await fs.readFile(file, "utf8")).toContain("Check deploys");
    expect(ctx.edits.at(-1)?.text).toContain(t("skills.imported", { name: "deploy-check" }));
    expect(ctx.edits.at(-1)?.text).toContain(t("skills.restart_hint"));
    expect(ctx.context.reply).not.toHaveBeenCalled();
  });

  it("keeps the flow active and renders invalid-link errors in place", async () => {
    const ctx = makeCtx();
    await startSkillImport(ctx.context);
    serviceMock.resolveSkillSource.mockRejectedValue(new Error("This is not a GitHub link"));
    expect(await sendText(ctx, "https://example.com/x")).toBe(true);
    expect(isSkillImportActive()).toBe(true);
    expect(ctx.edits.at(-1)?.text).toBe(t("skills.import.invalid_url"));

    serviceMock.resolveSkillSource.mockRejectedValue(new Error("No SKILL.md found in this location"));
    expect(await sendText(ctx, "https://github.com/o/r/tree/main/nope")).toBe(true);
    expect(ctx.edits.at(-1)?.text).toBe(t("skills.import.not_found"));
  });

  it("walks a multi-skill list one by one without creating prompt messages", async () => {
    const ctx = makeCtx();
    await startSkillImport(ctx.context);
    serviceMock.resolveSkillSource.mockResolvedValue({
      kind: "list",
      candidates: [
        { name: "alpha", url: "https://github.com/o/r/tree/main/skills/alpha" },
        { name: "beta", url: "https://github.com/o/r/tree/main/skills/beta" },
      ],
    });

    expect(await sendText(ctx, "https://github.com/o/r")).toBe(true);
    expect(ctx.edits.at(-1)?.text).toBe(t("skills.import.multiple_found", { count: 2 }));
    expect(ctx.lastKeyboard().flat().map((b) => b.callback_data)).toEqual([
      "skills:imp_pick:0",
      "skills:imp_pick:1",
      "skills:imp_cancel",
      "main:home",
    ]);

    serviceMock.fetchSkillFromGitHub.mockResolvedValue(skill("alpha", "Alpha skill"));
    expect(await handleSkillImportCallback(ctx.context, "skills:imp_pick:0")).toBe(true);
    expect(serviceMock.fetchSkillFromGitHub).toHaveBeenCalledWith(
      "https://github.com/o/r/tree/main/skills/alpha",
    );
    expect(ctx.lastKeyboard().flat().map((b) => b.callback_data)).toContain("skills:imp_confirm");

    expect(await handleSkillImportCallback(ctx.context, "skills:imp_confirm")).toBe(true);
    expect(isSkillImportActive()).toBe(true);
    expect(ctx.edits.at(-1)?.text).toBe(t("skills.import.multiple_found", { count: 1 }));

    expect(await handleSkillImportCallback(ctx.context, "skills:imp_cancel")).toBe(true);
    expect(isSkillImportActive()).toBe(false);
    expect(ctx.context.reply).not.toHaveBeenCalled();
  });

  it("reports duplicate skills on the same panel and stays active", async () => {
    const ctx = makeCtx();
    await startSkillImport(ctx.context);
    serviceMock.resolveSkillSource.mockResolvedValue({ kind: "single", skill: skill("dupe") });
    await sendText(ctx, "https://github.com/o/r");

    await fs.mkdir(path.join(tmpHome, ".config", "opencode", "skills", "dupe"), { recursive: true });
    await fs.writeFile(path.join(tmpHome, ".config", "opencode", "skills", "dupe", "SKILL.md"), "x", "utf8");

    expect(await handleSkillImportCallback(ctx.context, "skills:imp_confirm")).toBe(true);
    expect(isSkillImportActive()).toBe(true);
    expect(ctx.edits.at(-1)?.text).toBe(t("skills.import.exists", { name: "dupe" }));
  });
});

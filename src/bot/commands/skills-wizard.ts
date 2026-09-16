import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { isValidSkillName, updateGlobalSkill, writeGlobalSkill } from "../../app/services/skill-manage-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

type WizardMode = "create" | "edit";
type WizardStep = "name" | "description" | "body";

interface SkillWizardState {
  mode: WizardMode;
  step: WizardStep;
  name?: string;
  description?: string;
  expiresAt: number;
}

const WIZARD_TTL_MS = 15 * 60_000;
let wizard: SkillWizardState | null = null;

function freshState(mode: WizardMode, step: WizardStep, extra: Partial<SkillWizardState> = {}): SkillWizardState {
  return { mode, step, expiresAt: Date.now() + WIZARD_TTL_MS, ...extra };
}

export function isSkillWizardActive(): boolean {
  if (!wizard) return false;
  if (wizard.expiresAt < Date.now()) {
    wizard = null;
    return false;
  }
  return true;
}

export function clearSkillWizard(): void {
  wizard = null;
}

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(t("inline.button.cancel"), "skills:wizard_cancel");
}

export async function startSkillWizard(ctx: Context): Promise<void> {
  wizard = freshState("create", "name");
  await ctx.reply(t("skills.wizard.ask_name"), { reply_markup: cancelKeyboard() });
}

export async function startSkillEdit(ctx: Context, name: string): Promise<void> {
  wizard = freshState("edit", "description", { name });
  await ctx.reply(t("skills.edit.ask_description", { name }), { reply_markup: cancelKeyboard() });
}

export async function handleSkillWizardMessage(ctx: Context): Promise<boolean> {
  if (!isSkillWizardActive() || !wizard) return false;
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith("/")) return false;

  const current = wizard;
  try {
    if (current.step === "name") {
      const name = text.toLowerCase();
      if (!isValidSkillName(name)) {
        await ctx.reply(t("skills.wizard.invalid_name"), { reply_markup: cancelKeyboard() });
        return true;
      }
      wizard = freshState("create", "description", { name });
      await ctx.reply(t("skills.wizard.ask_description"), { reply_markup: cancelKeyboard() });
      return true;
    }

    if (current.step === "description") {
      wizard = freshState(current.mode, "body", { name: current.name, description: text });
      const nextPrompt = current.mode === "edit" ? t("skills.edit.ask_body") : t("skills.wizard.ask_body");
      await ctx.reply(nextPrompt, { reply_markup: cancelKeyboard() });
      return true;
    }

    const name = current.name;
    const description = current.description;
    if (!name || !description) {
      clearSkillWizard();
      await ctx.reply(t("callback.processing_error"));
      return true;
    }
    if (current.mode === "edit") {
      await updateGlobalSkill({ name, description, body: text });
    } else {
      await writeGlobalSkill({ name, description, body: text });
    }
    const savedMessage = current.mode === "edit" ? t("skills.edit.saved", { name }) : t("skills.wizard.saved", { name });
    clearSkillWizard();
    logger.info(`[SkillWizard] ${current.mode === "edit" ? "Updated" : "Created"} global skill: ${name}`);
    await ctx.reply(`${savedMessage}\n\n${t("skills.restart_hint")}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.warn(`[SkillWizard] Step failed: mode=${current.mode}, step=${current.step}, message=${message}`);
    await ctx.reply(t("skills.wizard.write_error", { error: message }), { reply_markup: cancelKeyboard() });
    return true;
  }
}

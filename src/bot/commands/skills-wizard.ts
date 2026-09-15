import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { isValidSkillName, writeGlobalSkill } from "../../app/services/skill-manage-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

type WizardStep = "name" | "description" | "body";

interface SkillWizardState {
  step: WizardStep;
  name?: string;
  description?: string;
  expiresAt: number;
}

const WIZARD_TTL_MS = 15 * 60_000;
let wizard: SkillWizardState | null = null;

function freshState(step: WizardStep, extra: Partial<SkillWizardState> = {}): SkillWizardState {
  return { step, expiresAt: Date.now() + WIZARD_TTL_MS, ...extra };
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
  wizard = freshState("name");
  await ctx.reply(t("skills.wizard.ask_name"), { reply_markup: cancelKeyboard() });
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
      wizard = freshState("description", { name });
      await ctx.reply(t("skills.wizard.ask_description"), { reply_markup: cancelKeyboard() });
      return true;
    }

    if (current.step === "description") {
      wizard = freshState("body", { name: current.name, description: text });
      await ctx.reply(t("skills.wizard.ask_body"), { reply_markup: cancelKeyboard() });
      return true;
    }

    const name = current.name;
    const description = current.description;
    if (!name || !description) {
      clearSkillWizard();
      await ctx.reply(t("callback.processing_error"));
      return true;
    }
    await writeGlobalSkill({ name, description, body: text });
    clearSkillWizard();
    logger.info(`[SkillWizard] Created global skill: ${name}`);
    await ctx.reply(`${t("skills.wizard.saved", { name })}\n\n${t("skills.restart_hint")}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.warn(`[SkillWizard] Step failed: step=${current.step}, message=${message}`);
    await ctx.reply(t("skills.wizard.write_error", { error: message }), { reply_markup: cancelKeyboard() });
    return true;
  }
}

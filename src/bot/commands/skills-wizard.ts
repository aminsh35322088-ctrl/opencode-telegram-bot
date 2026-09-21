import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { isValidSkillName, updateGlobalSkill, writeGlobalSkill } from "../../app/services/skill-manage-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { getMainNavigationMessageId } from "../../app/stores/settings-store.js";

type WizardMode = "create" | "edit";
type WizardStep = "name" | "description" | "body";

interface SkillWizardState {
  mode: WizardMode;
  step: WizardStep;
  messageId: number;
  name?: string;
  description?: string;
  expiresAt: number;
}

const WIZARD_TTL_MS = 15 * 60_000;
let wizard: SkillWizardState | null = null;

function callbackMessageId(ctx: Context): number | null {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  const canonical = typeof chatId === "number" ? getMainNavigationMessageId(chatId) : undefined;
  if (typeof canonical === "number") return canonical;
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  return typeof message.message_id === "number" ? message.message_id : null;
}

function freshState(
  mode: WizardMode,
  step: WizardStep,
  messageId: number,
  extra: Partial<SkillWizardState> = {},
): SkillWizardState {
  return { mode, step, messageId, expiresAt: Date.now() + WIZARD_TTL_MS, ...extra };
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

function wizardKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("← Skills", "skills:wizard_cancel")
    .text("🏠 Home", "main:home");
}

function doneKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("← Skills", "skills:list_back")
    .text("🏠 Home", "main:home");
}

async function editWizardPanel(
  ctx: Context,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard = wizardKeyboard(),
): Promise<void> {
  if (!ctx.chat?.id) return;
  await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: keyboard }).catch((error) => {
    if (!/message is not modified/i.test(error instanceof Error ? error.message : String(error))) throw error;
  });
}

async function deleteInput(ctx: Context): Promise<void> {
  if (!ctx.chat?.id || !ctx.message?.message_id) return;
  await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
}

export async function startSkillWizard(ctx: Context): Promise<void> {
  const messageId = callbackMessageId(ctx);
  if (messageId === null) {
    await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true }).catch(() => {});
    return;
  }
  wizard = freshState("create", "name", messageId);
  await editWizardPanel(ctx, messageId, t("skills.wizard.ask_name"));
}

export async function startSkillEdit(ctx: Context, name: string): Promise<void> {
  const messageId = callbackMessageId(ctx);
  if (messageId === null) {
    await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true }).catch(() => {});
    return;
  }
  wizard = freshState("edit", "description", messageId, { name });
  await editWizardPanel(ctx, messageId, t("skills.edit.ask_description", { name }));
}

export async function handleSkillWizardMessage(ctx: Context): Promise<boolean> {
  if (!isSkillWizardActive() || !wizard) return false;
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith("/")) return false;

  const current = wizard;
  await deleteInput(ctx);

  try {
    if (current.step === "name") {
      const name = text.toLowerCase();
      if (!isValidSkillName(name)) {
        await editWizardPanel(ctx, current.messageId, t("skills.wizard.invalid_name"));
        return true;
      }
      wizard = freshState("create", "description", current.messageId, { name });
      await editWizardPanel(ctx, current.messageId, t("skills.wizard.ask_description"));
      return true;
    }

    if (current.step === "description") {
      wizard = freshState(current.mode, "body", current.messageId, {
        name: current.name,
        description: text,
      });
      const nextPrompt = current.mode === "edit" ? t("skills.edit.ask_body") : t("skills.wizard.ask_body");
      await editWizardPanel(ctx, current.messageId, nextPrompt);
      return true;
    }

    const name = current.name;
    const description = current.description;
    if (!name || !description) {
      clearSkillWizard();
      await editWizardPanel(ctx, current.messageId, t("callback.processing_error"), doneKeyboard());
      return true;
    }

    if (current.mode === "edit") {
      await updateGlobalSkill({ name, description, body: text });
    } else {
      await writeGlobalSkill({ name, description, body: text });
    }

    const savedMessage = current.mode === "edit"
      ? t("skills.edit.saved", { name })
      : t("skills.wizard.saved", { name });
    clearSkillWizard();
    logger.info(`[SkillWizard] ${current.mode === "edit" ? "Updated" : "Created"} global skill: ${name}`);
    await editWizardPanel(ctx, current.messageId, `${savedMessage}\n\n${t("skills.restart_hint")}`, doneKeyboard());
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.warn(`[SkillWizard] Step failed: mode=${current.mode}, step=${current.step}, message=${message}`);
    await editWizardPanel(ctx, current.messageId, t("skills.wizard.write_error", { error: message }));
    return true;
  }
}
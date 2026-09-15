import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { writeGlobalSkillRaw } from "../../app/services/skill-manage-service.js";
import type { ImportedSkill, SkillImportCandidate } from "../../app/services/skill-import-service.js";
import { fetchSkillFromGitHub, resolveSkillSource } from "../../app/services/skill-import-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { clearSkillWizard } from "./skills-wizard.js";

export const SKILLS_IMPORT_CALLBACK_PREFIX = "skills:imp_";
export const SKILLS_IMPORT_CALLBACK_CONFIRM = `${SKILLS_IMPORT_CALLBACK_PREFIX}confirm`;
export const SKILLS_IMPORT_CALLBACK_CANCEL = `${SKILLS_IMPORT_CALLBACK_PREFIX}cancel`;
export const SKILLS_IMPORT_CALLBACK_PICK_PREFIX = `${SKILLS_IMPORT_CALLBACK_PREFIX}pick:`;

const IMPORT_TTL_MS = 15 * 60_000;

interface SkillImportState {
  pending?: ImportedSkill;
  candidates?: SkillImportCandidate[];
  expiresAt: number;
}

let state: SkillImportState | null = null;

function activeState(): SkillImportState | null {
  if (!state) return null;
  if (state.expiresAt < Date.now()) {
    state = null;
    return null;
  }
  return state;
}

export function isSkillImportActive(): boolean {
  return activeState() !== null;
}

export function clearSkillImportFlow(): void {
  state = null;
}

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(t("inline.button.cancel"), SKILLS_IMPORT_CALLBACK_CANCEL);
}

export async function startSkillImport(ctx: Context): Promise<void> {
  clearSkillWizard();
  state = { expiresAt: Date.now() + IMPORT_TTL_MS };
  await ctx.reply(t("skills.import.ask_url"), { reply_markup: cancelKeyboard() });
}

function classifyImportError(message: string): string {
  if (message.includes("GitHub")) {
    return t("skills.import.invalid_url");
  }
  if (message.includes("SKILL.md")) {
    return t("skills.import.not_found");
  }
  return t("skills.import.fetch_error", { error: message });
}

async function renderConfirmation(ctx: Context, skill: ImportedSkill, candidates?: SkillImportCandidate[]): Promise<void> {
  state = { pending: skill, candidates, expiresAt: Date.now() + IMPORT_TTL_MS };
  const keyboard = new InlineKeyboard()
    .text(t("skills.button.import_confirm"), SKILLS_IMPORT_CALLBACK_CONFIRM)
    .text(t("inline.button.cancel"), SKILLS_IMPORT_CALLBACK_CANCEL);
  await ctx.reply(t("skills.import.confirm", { skill: skill.name, description: skill.description, url: skill.sourceUrl }), {
    reply_markup: keyboard,
  });
}

async function renderCandidateList(ctx: Context, candidates: SkillImportCandidate[]): Promise<void> {
  state = { candidates, expiresAt: Date.now() + IMPORT_TTL_MS };
  const keyboard = new InlineKeyboard();
  candidates.forEach((candidate, index) => {
    keyboard.text(`/${candidate.name}`, `${SKILLS_IMPORT_CALLBACK_PICK_PREFIX}${index}`).row();
  });
  keyboard.text(t("inline.button.cancel"), SKILLS_IMPORT_CALLBACK_CANCEL);
  await ctx.reply(t("skills.import.multiple_found", { count: candidates.length }), { reply_markup: keyboard });
}

export async function handleSkillImportMessage(ctx: Context): Promise<boolean> {
  const current = activeState();
  if (!current) return false;
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith("/")) return false;

  try {
    const resolved = await resolveSkillSource(text);
    if (resolved.kind === "single") {
      await renderConfirmation(ctx, resolved.skill);
    } else {
      await renderCandidateList(ctx, resolved.candidates);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.warn(`[SkillImport] Resolve failed: ${message}`);
    await ctx.reply(classifyImportError(message), { reply_markup: cancelKeyboard() });
    return true;
  }
}

export async function handleSkillImportCallback(ctx: Context, data: string): Promise<boolean> {
  if (!data.startsWith(SKILLS_IMPORT_CALLBACK_PREFIX)) {
    return false;
  }

  const current = activeState();
  if (!current) {
    await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
    return true;
  }

  if (data === SKILLS_IMPORT_CALLBACK_CANCEL) {
    clearSkillImportFlow();
    await ctx.answerCallbackQuery({ text: t("common.cancelled") });
    await ctx.editMessageText(t("skills.import.cancelled")).catch(() => {});
    return true;
  }

  if (data === SKILLS_IMPORT_CALLBACK_CONFIRM) {
    if (!current.pending) {
      await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
      return true;
    }
    const skill = current.pending;
    try {
      await writeGlobalSkillRaw(skill.name, skill.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      logger.warn(`[SkillImport] Write failed: skill=${skill.name}, message=${message}`);
      await ctx.answerCallbackQuery({ text: t("skills.import.fetch_error", { error: message }), show_alert: true });
      if (message.includes("already exists")) {
        await ctx.reply(t("skills.import.exists", { name: skill.name }), { reply_markup: cancelKeyboard() });
      }
      return true;
    }

    await ctx.answerCallbackQuery();
    logger.info(`[SkillImport] Imported global skill: ${skill.name}`);
    await ctx.reply(`${t("skills.imported", { name: skill.name })}\n\n${t("skills.restart_hint")}`);

    const remaining = (current.candidates ?? []).filter((candidate) => candidate.name !== skill.name);
    if (remaining.length > 0) {
      await renderCandidateList(ctx, remaining);
    } else {
      clearSkillImportFlow();
    }
    return true;
  }

  const pickIndex = data.startsWith(SKILLS_IMPORT_CALLBACK_PICK_PREFIX)
    ? Number(data.slice(SKILLS_IMPORT_CALLBACK_PICK_PREFIX.length))
    : Number.NaN;
  if (Number.isInteger(pickIndex) && pickIndex >= 0) {
    const candidate = current.candidates?.[pickIndex];
    if (!candidate) {
      await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
      return true;
    }
    try {
      const skill = await fetchSkillFromGitHub(candidate.url);
      await ctx.answerCallbackQuery();
      const others = (current.candidates ?? []).filter((item) => item.name !== candidate.name);
      await renderConfirmation(ctx, skill, others.length > 0 ? others : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      logger.warn(`[SkillImport] Candidate fetch failed: ${message}`);
      await ctx.answerCallbackQuery({ text: classifyImportError(message), show_alert: true });
    }
    return true;
  }

  await ctx.answerCallbackQuery({ text: t("callback.unknown_command") });
  return true;
}

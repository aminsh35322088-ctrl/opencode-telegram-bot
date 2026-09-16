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
  messageId: number;
  pending?: ImportedSkill;
  candidates?: SkillImportCandidate[];
  expiresAt: number;
}

let state: SkillImportState | null = null;

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  return typeof message.message_id === "number" ? message.message_id : null;
}

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

function navigationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("← Skills", SKILLS_IMPORT_CALLBACK_CANCEL)
    .text("🏠 Home", "main:home");
}

async function editImportPanel(
  ctx: Context,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard = navigationKeyboard(),
): Promise<void> {
  if (!ctx.chat?.id) return;
  await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: keyboard });
}

async function deleteInput(ctx: Context): Promise<void> {
  if (!ctx.chat?.id || !ctx.message?.message_id) return;
  await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
}

export async function startSkillImport(ctx: Context): Promise<void> {
  clearSkillWizard();
  const messageId = callbackMessageId(ctx);
  if (messageId === null) {
    await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true }).catch(() => {});
    return;
  }
  state = { messageId, expiresAt: Date.now() + IMPORT_TTL_MS };
  await editImportPanel(ctx, messageId, t("skills.import.ask_url"));
}

function classifyImportError(message: string): string {
  if (message.includes("GitHub")) return t("skills.import.invalid_url");
  if (message.includes("SKILL.md")) return t("skills.import.not_found");
  return t("skills.import.fetch_error", { error: message });
}

async function renderConfirmation(
  ctx: Context,
  messageId: number,
  skill: ImportedSkill,
  candidates?: SkillImportCandidate[],
): Promise<void> {
  state = { messageId, pending: skill, candidates, expiresAt: Date.now() + IMPORT_TTL_MS };
  const keyboard = new InlineKeyboard()
    .text(t("skills.button.import_confirm"), SKILLS_IMPORT_CALLBACK_CONFIRM).row()
    .text("← Skills", SKILLS_IMPORT_CALLBACK_CANCEL)
    .text("🏠 Home", "main:home");
  await editImportPanel(
    ctx,
    messageId,
    t("skills.import.confirm", { skill: skill.name, description: skill.description, url: skill.sourceUrl }),
    keyboard,
  );
}

async function renderCandidateList(
  ctx: Context,
  messageId: number,
  candidates: SkillImportCandidate[],
): Promise<void> {
  state = { messageId, candidates, expiresAt: Date.now() + IMPORT_TTL_MS };
  const keyboard = new InlineKeyboard();
  candidates.forEach((candidate, index) => {
    keyboard.text(`/${candidate.name}`, `${SKILLS_IMPORT_CALLBACK_PICK_PREFIX}${index}`).row();
  });
  keyboard.text("← Skills", SKILLS_IMPORT_CALLBACK_CANCEL).text("🏠 Home", "main:home");
  await editImportPanel(ctx, messageId, t("skills.import.multiple_found", { count: candidates.length }), keyboard);
}

export async function handleSkillImportMessage(ctx: Context): Promise<boolean> {
  const current = activeState();
  if (!current) return false;
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith("/")) return false;

  await deleteInput(ctx);
  try {
    const resolved = await resolveSkillSource(text);
    if (resolved.kind === "single") {
      await renderConfirmation(ctx, current.messageId, resolved.skill);
    } else {
      await renderCandidateList(ctx, current.messageId, resolved.candidates);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.warn(`[SkillImport] Resolve failed: ${message}`);
    await editImportPanel(ctx, current.messageId, classifyImportError(message));
    return true;
  }
}

export async function handleSkillImportCallback(ctx: Context, data: string): Promise<boolean> {
  if (!data.startsWith(SKILLS_IMPORT_CALLBACK_PREFIX)) return false;

  const current = activeState();
  const messageId = callbackMessageId(ctx);
  if (!current || messageId === null || current.messageId !== messageId) {
    await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
    return true;
  }

  if (data === SKILLS_IMPORT_CALLBACK_CANCEL) {
    clearSkillImportFlow();
    await ctx.answerCallbackQuery({ text: t("common.cancelled") }).catch(() => {});
    await ctx.editMessageText(t("skills.import.cancelled"), {
      reply_markup: new InlineKeyboard().text("← Skills", "skills:list_back").text("🏠 Home", "main:home"),
    }).catch(() => {});
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
        await editImportPanel(ctx, current.messageId, t("skills.import.exists", { name: skill.name }));
      }
      return true;
    }

    await ctx.answerCallbackQuery();
    logger.info(`[SkillImport] Imported global skill: ${skill.name}`);
    const remaining = (current.candidates ?? []).filter((candidate) => candidate.name !== skill.name);
    if (remaining.length > 0) {
      await renderCandidateList(ctx, current.messageId, remaining);
    } else {
      clearSkillImportFlow();
      await ctx.editMessageText(`${t("skills.imported", { name: skill.name })}\n\n${t("skills.restart_hint")}`, {
        reply_markup: new InlineKeyboard().text("← Skills", "skills:list_back").text("🏠 Home", "main:home"),
      }).catch(() => {});
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
      await renderConfirmation(ctx, current.messageId, skill, others.length > 0 ? others : undefined);
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
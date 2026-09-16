import { InlineKeyboard, type Context } from "grammy";
import { config } from "../../config.js";
import type { SkillCatalogItem } from "../../app/services/skills-catalog-service.js";
import { loadSkillsCatalog } from "../../app/services/skills-catalog-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import type { InteractionState } from "../../app/types/interaction.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { cancelMenu } from "./feedback.js";
import { processUserPrompt, type ProcessPromptDeps } from "../handlers/prompt.js";
import { clearSkillWizard, startSkillEdit, startSkillWizard } from "../commands/skills-wizard.js";
import { clearSkillImportFlow, handleSkillImportCallback, SKILLS_IMPORT_CALLBACK_PREFIX, startSkillImport } from "../commands/skills-import-flow.js";
import { deleteGlobalSkill, isManagedSkillLocation } from "../../app/services/skill-manage-service.js";
import {
  buildSkillsConfirmKeyboard,
  buildSkillsListKeyboard,
  calculateSkillsPaginationRange,
  formatExecutingSkillMessage,
  formatSkillDetailView,
  formatSkillsSelectText,
  parseSkillPageCallback,
  parseSkillSelectCallback,
  SKILLS_CALLBACK_CANCEL,
  SKILLS_CALLBACK_EDIT,
  SKILLS_CALLBACK_DELETE,
  SKILLS_CALLBACK_DELETE_CANCEL,
  SKILLS_CALLBACK_DELETE_CONFIRM,
  SKILLS_CALLBACK_EXECUTE,
  SKILLS_CALLBACK_IMPORT,
  SKILLS_CALLBACK_NEW,
  SKILLS_CALLBACK_PREFIX,
  SKILLS_CALLBACK_REFRESH,
  SKILLS_CALLBACK_WIZARD_CANCEL,
} from "../menus/skills-catalog-menu.js";

interface SkillsListMetadata {
  flow: "skills";
  stage: "list";
  messageId: number;
  projectDirectory: string;
  skills: SkillCatalogItem[];
  page: number;
}

interface SkillsConfirmMetadata {
  flow: "skills";
  stage: "confirm";
  messageId: number;
  projectDirectory: string;
  skillName: string;
  skillLocation?: string | undefined;
}

export type SkillsMetadata = SkillsListMetadata | SkillsConfirmMetadata;

export interface ExecuteSkillParams {
  projectDirectory: string;
  skillName: string;
  argumentsText: string;
}

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function parseSkillItems(value: unknown): SkillCatalogItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const skills: SkillCatalogItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const skillName = (item as { name?: unknown }).name;
    if (typeof skillName !== "string" || !skillName.trim()) {
      return null;
    }

    const description = (item as { description?: unknown }).description;
    const location = (item as { location?: unknown }).location;
    const developer = (item as { developer?: unknown }).developer;
    const version = (item as { version?: unknown }).version;
    const updatedAt = (item as { updatedAt?: unknown }).updatedAt;
    skills.push({
      name: skillName,
      description: typeof description === "string" ? description : undefined,
      location: typeof location === "string" ? location : undefined,
      developer: typeof developer === "string" ? developer : undefined,
      version: typeof version === "string" ? version : undefined,
      updatedAt: typeof updatedAt === "string" ? updatedAt : undefined,
    });
  }

  return skills;
}

export function parseSkillsMetadata(state: InteractionState | null): SkillsMetadata | null {
  if (!state || state.kind !== "custom") {
    return null;
  }

  const flow = state.metadata.flow;
  const stage = state.metadata.stage;
  const messageId = state.metadata.messageId;
  const projectDirectory = state.metadata.projectDirectory;

  if (flow !== "skills" || typeof messageId !== "number" || typeof projectDirectory !== "string") {
    return null;
  }

  if (stage === "list") {
    const skills = parseSkillItems(state.metadata.skills);
    if (!skills) {
      return null;
    }

    const page =
      typeof state.metadata.page === "number" && Number.isInteger(state.metadata.page)
        ? Math.max(0, state.metadata.page)
        : 0;

    return {
      flow,
      stage,
      messageId,
      projectDirectory,
      skills,
      page,
    };
  }

  if (stage === "confirm") {
    const skillName = state.metadata.skillName;
    if (typeof skillName !== "string" || !skillName.trim()) {
      return null;
    }

    const skillLocation = typeof state.metadata.skillLocation === "string" ? state.metadata.skillLocation : undefined;
    return {
      flow,
      stage,
      messageId,
      projectDirectory,
      skillName,
      skillLocation,
    };
  }

  return null;
}

export function clearSkillsInteraction(reason: string): void {
  const metadata = parseSkillsMetadata(interactionManager.getSnapshot());
  if (metadata) {
    interactionManager.clear(reason);
  }
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message is not modified/i.test(message);
}

async function editCatalogMessageIgnoringNoop(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (error) {
    if (!isMessageNotModifiedError(error)) {
      throw error;
    }
  }
}

export async function executeSkill(
  ctx: Context,
  deps: ProcessPromptDeps,
  params: ExecuteSkillParams,
): Promise<void> {
  const currentProject = getCurrentProject();
  if (!currentProject) {
    await ctx.reply(t("bot.project_not_selected"));
    return;
  }

  if (currentProject.worktree !== params.projectDirectory) {
    logger.warn(
      `[Skills] Project changed between selection and execution. listedProject=${params.projectDirectory}, currentProject=${currentProject.worktree}. Using current project.`,
    );
  }

  const args = params.argumentsText.trim();
  const executingMessage = formatExecutingSkillMessage(params.skillName, args);
  await ctx.reply(executingMessage.text, { entities: executingMessage.entities });

  const promptText = args ? `/${params.skillName} ${args}` : `/${params.skillName}`;
  await processUserPrompt(ctx, promptText, deps);
}

async function recoverSkillsListInteraction(ctx: Context): Promise<boolean> {
  const messageId = getCallbackMessageId(ctx);
  if (messageId === null) return false;
  const projectDirectory = getCurrentSessionDirectory();
  if (!projectDirectory) return false;
  let skills: SkillCatalogItem[];
  try {
    skills = await loadSkillsCatalog(projectDirectory);
  } catch (error) {
    logger.warn("[Skills] Failed to recover skills list interaction:", error);
    return false;
  }
  const pageSize = config.bot.commandsListLimit;
  const keyboard = buildSkillsListKeyboard(skills, 0, pageSize);
  try {
    await editCatalogMessageIgnoringNoop(ctx, formatSkillsSelectText(0), keyboard);
  } catch (error) {
    logger.warn("[Skills] Failed to re-render skills list during recovery:", error);
    return false;
  }
  interactionManager.start({ kind: "custom", expectedInput: "callback", metadata: { flow: "skills", stage: "list", messageId, projectDirectory, skills, page: 0 } });
  await ctx.answerCallbackQuery().catch(() => {});
  return true;
}

export async function handleSkillsCallback(
  ctx: Context,
  deps: ProcessPromptDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(SKILLS_CALLBACK_PREFIX)) {
    return false;
  }

  if (data.startsWith(SKILLS_IMPORT_CALLBACK_PREFIX)) {
    return handleSkillImportCallback(ctx, data);
  }

  let metadata = parseSkillsMetadata(interactionManager.getSnapshot());
  const callbackMessageId = getCallbackMessageId(ctx);

  if (!metadata || callbackMessageId === null || metadata.messageId !== callbackMessageId) {
    if (!(await recoverSkillsListInteraction(ctx))) {
      await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
      return true;
    }
    metadata = parseSkillsMetadata(interactionManager.getSnapshot());
    if (!metadata || callbackMessageId === null || metadata.messageId !== callbackMessageId) {
      await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
      return true;
    }
  }

  try {
    if (data === SKILLS_CALLBACK_CANCEL) {
      clearSkillsInteraction("skills_cancelled");
      await cancelMenu(ctx);
      return true;
    }

    if (data === SKILLS_CALLBACK_EXECUTE) {
      if (metadata.stage !== "confirm") {
        await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
        return true;
      }

      clearSkillsInteraction("skills_execute_clicked");
      await ctx.answerCallbackQuery({ text: t("skills.execute_callback") });
      await ctx.deleteMessage().catch(() => {});

      await executeSkill(ctx, deps, {
        projectDirectory: metadata.projectDirectory,
        skillName: metadata.skillName,
        argumentsText: "",
      });
      return true;
    }

    if (data === SKILLS_CALLBACK_NEW) {
      clearSkillsInteraction("skills_wizard_start");
      clearSkillImportFlow();
      await ctx.answerCallbackQuery();
      await startSkillWizard(ctx);
      return true;
    }

    if (data === SKILLS_CALLBACK_IMPORT) {
      if (metadata.stage !== "list") {
        await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
        return true;
      }
      clearSkillsInteraction("skills_import_start");
      await ctx.answerCallbackQuery();
      await startSkillImport(ctx);
      return true;
    }

    if (data === SKILLS_CALLBACK_WIZARD_CANCEL) {
      clearSkillWizard();
      await ctx.answerCallbackQuery({ text: t("common.cancelled") });
      await ctx.editMessageText(t("skills.wizard.cancelled")).catch(() => {});
      return true;
    }

    if (data === SKILLS_CALLBACK_EDIT) {
      if (metadata.stage !== "confirm" || !isManagedSkillLocation(metadata.skillLocation)) {
        await ctx.answerCallbackQuery({ text: t("skills.edit_not_managed"), show_alert: true });
        return true;
      }
      clearSkillsInteraction("skills_edit_clicked");
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage().catch(() => {});
      await startSkillEdit(ctx, metadata.skillName);
      return true;
    }

    if (data === SKILLS_CALLBACK_DELETE) {
      if (metadata.stage !== "confirm" || !isManagedSkillLocation(metadata.skillLocation)) {
        await ctx.answerCallbackQuery({ text: t("skills.delete_not_managed"), show_alert: true });
        return true;
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t("skills.delete_confirm", { skill: metadata.skillName }), {
        reply_markup: new InlineKeyboard()
          .text(t("skills.button.delete_confirm"), SKILLS_CALLBACK_DELETE_CONFIRM)
          .text(t("skills.button.delete_cancel"), SKILLS_CALLBACK_DELETE_CANCEL),
      });
      return true;
    }

    if (data === SKILLS_CALLBACK_DELETE_CONFIRM) {
      if (metadata.stage !== "confirm") {
        await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
        return true;
      }
      clearSkillsInteraction("skills_delete_confirmed");
      await ctx.answerCallbackQuery();
      const deleted = await deleteGlobalSkill(metadata.skillName);
      await ctx.editMessageText(
        deleted
          ? `${t("skills.deleted", { name: metadata.skillName })}\n\n${t("skills.restart_hint")}`
          : t("skills.delete_failed"),
      ).catch(() => {});
      return true;
    }

    if (data === SKILLS_CALLBACK_DELETE_CANCEL) {
      await ctx.answerCallbackQuery({ text: t("common.cancelled") });
      return true;
    }

    if (data === SKILLS_CALLBACK_REFRESH) {
      if (metadata.stage !== "list") {
        await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
        return true;
      }

      let skills: SkillCatalogItem[];
      try {
        skills = await loadSkillsCatalog(metadata.projectDirectory);
      } catch (error) {
        logger.warn("[Skills] Catalog refresh failed:", error);
        await ctx.answerCallbackQuery({ text: t("skills.fetch_error"), show_alert: true });
        return true;
      }

      const pageSize = config.bot.commandsListLimit;
      const keyboard = buildSkillsListKeyboard(skills, 0, pageSize);
      await ctx.answerCallbackQuery();
      await editCatalogMessageIgnoringNoop(ctx, formatSkillsSelectText(0), keyboard);
      interactionManager.transition({
        expectedInput: "callback",
        metadata: {
          flow: "skills",
          stage: "list",
          messageId: metadata.messageId,
          projectDirectory: metadata.projectDirectory,
          skills,
          page: 0,
        },
      });
      return true;
    }

    const page = parseSkillPageCallback(data);
    if (page !== null) {
      if (metadata.stage !== "list") {
        await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
        return true;
      }

      const pageSize = config.bot.commandsListLimit;
      const { page: normalizedPage, totalPages } = calculateSkillsPaginationRange(
        metadata.skills.length,
        page,
        pageSize,
      );

      if (page >= totalPages || page < 0) {
        await ctx.answerCallbackQuery({ text: t("skills.page_empty_callback") });
        return true;
      }

      const keyboard = buildSkillsListKeyboard(metadata.skills, normalizedPage, pageSize);
      await ctx.answerCallbackQuery();
      await editCatalogMessageIgnoringNoop(ctx, formatSkillsSelectText(normalizedPage), keyboard);

      interactionManager.transition({
        expectedInput: "callback",
        metadata: {
          flow: "skills",
          stage: "list",
          messageId: metadata.messageId,
          projectDirectory: metadata.projectDirectory,
          skills: metadata.skills,
          page: normalizedPage,
        },
      });

      return true;
    }

    const skillIndex = parseSkillSelectCallback(data);
    if (skillIndex === null || metadata.stage !== "list") {
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
      return true;
    }

    const selectedSkill = metadata.skills[skillIndex];
    if (!selectedSkill) {
      await ctx.answerCallbackQuery({ text: t("skills.inactive_callback"), show_alert: true });
      return true;
    }

    await ctx.answerCallbackQuery();
    const canManage = isManagedSkillLocation(selectedSkill.location);
    const confirmText = selectedSkill.location
      ? formatSkillDetailView(selectedSkill)
      : t("skills.confirm", { skill: `/${selectedSkill.name}` });
    await ctx.editMessageText(confirmText, {
      reply_markup: buildSkillsConfirmKeyboard(canManage),
    });

    interactionManager.transition({
      expectedInput: "mixed",
      metadata: {
        flow: "skills",
        stage: "confirm",
        messageId: metadata.messageId,
        projectDirectory: metadata.projectDirectory,
        skillName: selectedSkill.name,
        skillLocation: selectedSkill.location,
      },
    });

    return true;
  } catch (error) {
    logger.error("[Skills] Error handling skill callback:", error);
    clearSkillsInteraction("skills_callback_error");
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}

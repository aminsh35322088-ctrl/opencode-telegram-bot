import { InlineKeyboard } from "grammy";
import type { SkillCatalogItem } from "../../app/services/skills-catalog-service.js";
import { t } from "../../i18n/index.js";

export const SKILLS_CALLBACK_PREFIX = "skills:";
export const SKILLS_CALLBACK_SELECT_PREFIX = `${SKILLS_CALLBACK_PREFIX}select:`;
const SKILLS_CALLBACK_PAGE_PREFIX = `${SKILLS_CALLBACK_PREFIX}page:`;
export const SKILLS_CALLBACK_CANCEL = `${SKILLS_CALLBACK_PREFIX}cancel`;
export const SKILLS_CALLBACK_EXECUTE = `${SKILLS_CALLBACK_PREFIX}execute`;
export const SKILLS_CALLBACK_BACK = `${SKILLS_CALLBACK_PREFIX}back`;
export const SKILLS_CALLBACK_LIST_BACK = `${SKILLS_CALLBACK_PREFIX}list_back`;
export const SKILLS_CALLBACK_NEW = `${SKILLS_CALLBACK_PREFIX}new`;
export const SKILLS_CALLBACK_IMPORT = `${SKILLS_CALLBACK_PREFIX}import`;
export const SKILLS_CALLBACK_REFRESH = `${SKILLS_CALLBACK_PREFIX}refresh`;
export const SKILLS_CALLBACK_WIZARD_CANCEL = `${SKILLS_CALLBACK_PREFIX}wizard_cancel`;
export const SKILLS_CALLBACK_EDIT = `${SKILLS_CALLBACK_PREFIX}edit`;
export const SKILLS_CALLBACK_DELETE = `${SKILLS_CALLBACK_PREFIX}delete`;
export const SKILLS_CALLBACK_DELETE_CONFIRM = `${SKILLS_CALLBACK_PREFIX}delete_confirm`;
export const SKILLS_CALLBACK_DELETE_CANCEL = `${SKILLS_CALLBACK_PREFIX}delete_cancel`;

const MAX_INLINE_BUTTON_LABEL_LENGTH = 64;

interface ExecutingSkillMessage {
  text: string;
  entities: Array<{ type: "code"; offset: number; length: number }>;
}

export interface SkillsPaginationRange {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
}

export function formatExecutingSkillMessage(skillName: string, args: string): ExecutingSkillMessage {
  const prefix = t("skills.executing_prefix");
  const skillText = `/${skillName}`;
  const argsSuffix = args ? ` ${args}` : "";
  return {
    text: `${prefix}\n${skillText}${argsSuffix}`,
    entities: [{ type: "code", offset: prefix.length + 1, length: skillText.length }],
  };
}

export function buildSkillPageCallback(page: number): string {
  return `${SKILLS_CALLBACK_PAGE_PREFIX}${page}`;
}

export function parseSkillPageCallback(data: string): number | null {
  if (!data.startsWith(SKILLS_CALLBACK_PAGE_PREFIX)) return null;
  const page = Number(data.slice(SKILLS_CALLBACK_PAGE_PREFIX.length));
  return Number.isInteger(page) && page >= 0 ? page : null;
}

export function parseSkillSelectCallback(data: string): number | null {
  if (!data.startsWith(SKILLS_CALLBACK_SELECT_PREFIX)) return null;
  const index = Number(data.slice(SKILLS_CALLBACK_SELECT_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export function formatSkillsSelectText(page: number): string {
  return page === 0 ? t("skills.select") : t("skills.select_page", { page: page + 1 });
}

export function prettifySkillName(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function formatSkillButtonLabel(skill: SkillCatalogItem): string {
  const label = prettifySkillName(skill.name);
  return label.length <= MAX_INLINE_BUTTON_LABEL_LENGTH
    ? label
    : `${label.slice(0, MAX_INLINE_BUTTON_LABEL_LENGTH - 3)}...`;
}

export function formatSkillDetailView(skill: SkillCatalogItem): string {
  const lines = [t("skills.confirm", { skill: `/${skill.name}` }), "", skill.description?.trim() || t("skills.no_description")];
  if (skill.developer) {
    lines.push(
      skill.version
        ? t("skills.meta.developer_version", { developer: skill.developer, version: skill.version })
        : t("skills.meta.developer", { developer: skill.developer }),
    );
  }
  if (skill.location && skill.location !== "<built-in>") lines.push(t("skills.meta.source", { location: skill.location }));
  if (skill.updatedAt) lines.push(t("skills.meta.updated", { date: skill.updatedAt }));
  return lines.join("\n");
}

export function calculateSkillsPaginationRange(totalSkills: number, page: number, pageSize: number): SkillsPaginationRange {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalSkills / safePageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = normalizedPage * safePageSize;
  return {
    page: normalizedPage,
    totalPages,
    startIndex,
    endIndex: Math.min(startIndex + safePageSize, totalSkills),
  };
}

export function buildSkillsListKeyboard(skills: SkillCatalogItem[], page: number, pageSize: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const { page: normalizedPage, totalPages, startIndex, endIndex } = calculateSkillsPaginationRange(skills.length, page, pageSize);
  skills.slice(startIndex, endIndex).forEach((skill, index) => {
    keyboard.text(formatSkillButtonLabel(skill), `${SKILLS_CALLBACK_SELECT_PREFIX}${startIndex + index}`).row();
  });
  if (totalPages > 1) {
    if (normalizedPage > 0) keyboard.text(t("skills.button.prev_page"), buildSkillPageCallback(normalizedPage - 1));
    if (normalizedPage < totalPages - 1) keyboard.text(t("skills.button.next_page"), buildSkillPageCallback(normalizedPage + 1));
    keyboard.row();
  }
  keyboard.text(t("skills.button.new"), SKILLS_CALLBACK_NEW).row();
  keyboard.text(t("skills.button.import"), SKILLS_CALLBACK_IMPORT).text(t("skills.button.refresh"), SKILLS_CALLBACK_REFRESH).row();
  keyboard.text("← Back", SKILLS_CALLBACK_BACK).text("🏠 Home", "main:home");
  return keyboard;
}

export function buildSkillsConfirmKeyboard(canManage: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(t("skills.button.execute"), SKILLS_CALLBACK_EXECUTE);
  if (canManage) {
    keyboard.text(t("skills.button.edit"), SKILLS_CALLBACK_EDIT);
    keyboard.text(t("skills.button.delete"), SKILLS_CALLBACK_DELETE);
  }
  return keyboard.row().text("← Skills", SKILLS_CALLBACK_LIST_BACK).text("🏠 Home", "main:home");
}
import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

const SKILL_NAME_PATTERN = /^[a-z0-9](?:-?[a-z0-9]){0,63}$/u;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_BODY_LENGTH = 8000;

export function getGlobalSkillsDir(): string {
  return path.join(getRuntimePaths().appHome, ".config", "opencode", "skills");
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

export function isManagedSkillLocation(location: string | undefined): boolean {
  if (!location) return false;
  const root = path.resolve(getGlobalSkillsDir());
  const resolved = path.resolve(location);
  return resolved !== root && resolved.startsWith(`${root}${path.sep}`);
}

function normalizeFrontmatterValue(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/"/gu, "'").trim();
}

function buildSkillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`;
}

function validateSkillInput(input: { name: string; description: string; body: string }): {
  description: string;
  body: string;
} {
  if (!isValidSkillName(input.name)) throw new Error("Invalid skill name");
  const description = normalizeFrontmatterValue(input.description).slice(0, MAX_DESCRIPTION_LENGTH);
  if (!description) throw new Error("Skill description is empty");
  const body = input.body.trim().slice(0, MAX_BODY_LENGTH);
  if (!body) throw new Error("Skill body is empty");
  return { description, body };
}

function resolveManagedSkillFile(name: string): string {
  const root = path.resolve(getGlobalSkillsDir());
  const skillDir = path.resolve(root, name);
  if (skillDir === root || !skillDir.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to write skill outside the global skills directory");
  }
  return path.join(skillDir, "SKILL.md");
}

export async function writeGlobalSkill(input: {
  name: string;
  description: string;
  body: string;
}): Promise<string> {
  const { description, body } = validateSkillInput(input);
  const skillFile = resolveManagedSkillFile(input.name);
  const existing = await fs.stat(skillFile).catch(() => null);
  if (existing) throw new Error(`Skill "${input.name}" already exists`);

  await fs.mkdir(path.dirname(skillFile), { recursive: true });
  await fs.writeFile(skillFile, buildSkillMarkdown(input.name, description, body), "utf8");
  return skillFile;
}

export async function updateGlobalSkill(input: {
  name: string;
  description: string;
  body: string;
}): Promise<string> {
  const { description, body } = validateSkillInput(input);
  const skillFile = resolveManagedSkillFile(input.name);
  const existing = await fs.stat(skillFile).catch(() => null);
  if (!existing) throw new Error(`Skill "${input.name}" does not exist`);

  await fs.writeFile(skillFile, buildSkillMarkdown(input.name, description, body), "utf8");
  return skillFile;
}

export async function writeGlobalSkillRaw(name: string, content: string): Promise<string> {
  if (!isValidSkillName(name)) throw new Error("Invalid skill name");
  if (!content.trim()) throw new Error("Skill content is empty");
  const skillFile = resolveManagedSkillFile(name);
  const existing = await fs.stat(skillFile).catch(() => null);
  if (existing) throw new Error(`Skill "${name}" already exists`);

  await fs.mkdir(path.dirname(skillFile), { recursive: true });
  await fs.writeFile(skillFile, content, "utf8");
  return skillFile;
}

export async function deleteGlobalSkill(name: string): Promise<boolean> {
  if (!isValidSkillName(name)) return false;
  const root = path.resolve(getGlobalSkillsDir());
  const skillDir = path.resolve(root, name);
  if (skillDir === root || !skillDir.startsWith(`${root}${path.sep}`)) return false;
  const stat = await fs.stat(path.join(skillDir, "SKILL.md")).catch(() => null);
  if (!stat) return false;
  await fs.rm(skillDir, { recursive: true, force: true });
  return true;
}

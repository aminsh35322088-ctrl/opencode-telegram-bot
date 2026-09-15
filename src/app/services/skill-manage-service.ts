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

export async function writeGlobalSkill(input: {
  name: string;
  description: string;
  body: string;
}): Promise<string> {
  if (!isValidSkillName(input.name)) throw new Error("Invalid skill name");
  const description = normalizeFrontmatterValue(input.description).slice(0, MAX_DESCRIPTION_LENGTH);
  if (!description) throw new Error("Skill description is empty");
  const body = input.body.trim().slice(0, MAX_BODY_LENGTH);
  if (!body) throw new Error("Skill body is empty");

  const root = path.resolve(getGlobalSkillsDir());
  const skillDir = path.resolve(root, input.name);
  if (skillDir === root || !skillDir.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to write skill outside the global skills directory");
  }
  const skillFile = path.join(skillDir, "SKILL.md");
  const existing = await fs.stat(skillFile).catch(() => null);
  if (existing) throw new Error(`Skill "${input.name}" already exists`);

  const content = `---\nname: ${input.name}\ndescription: "${description}"\n---\n\n${body}\n`;
  await fs.mkdir(skillDir, { recursive: true });
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

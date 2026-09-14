import { opencodeClient } from "../../opencode/client.js";

export interface SkillCatalogItem {
  name: string;
  description?: string | undefined;
  location?: string | undefined;
}

const MAX_CATALOG_SIZE = 200;

function normalizeDirectory(projectDirectory: string): string {
  return projectDirectory.replace(/\\/g, "/");
}

/** Load skills directly from OpenCode's native v2 skill registry. */
export async function loadSkillsCatalog(projectDirectory: string): Promise<SkillCatalogItem[]> {
  const { data, error } = await opencodeClient.v2.skill.list({
    location: { directory: normalizeDirectory(projectDirectory) },
  });

  if (error || !data) {
    throw error || new Error("No skill data received");
  }

  return data.data
    .filter((skill) => typeof skill.name === "string" && skill.name.trim().length > 0)
    .map((skill) => ({
      name: skill.name.trim(),
      description:
        typeof skill.description === "string" && skill.description.trim()
          ? skill.description.trim()
          : undefined,
      location:
        typeof skill.location === "string" && skill.location.trim()
          ? skill.location.trim()
          : undefined,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_CATALOG_SIZE);
}

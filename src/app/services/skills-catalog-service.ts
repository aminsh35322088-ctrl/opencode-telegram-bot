import { opencodeClient } from "../../opencode/client.js";
import { deriveSkillDescription } from "./skill-markdown.js";

export interface SkillCatalogItem {
  name: string;
  description?: string | undefined;
  location?: string | undefined;
}

const MAX_CATALOG_SIZE = 200;

function normalizeDirectory(projectDirectory: string): string {
  return projectDirectory.replace(/\\/g, "/");
}

/**
 * Load skills from the OpenCode skill registry (server `/skill` endpoint).
 * The location-scoped v2 endpoint (`/api/skill`) omits plugin-provided skills,
 * so the server-wide listing is used to keep Superpowers-style plugins visible.
 */
export async function loadSkillsCatalog(projectDirectory: string): Promise<SkillCatalogItem[]> {
  const { data, error } = await opencodeClient.app.skills({
    directory: normalizeDirectory(projectDirectory),
  });

  if (error || !data) {
    throw error || new Error("No skill data received");
  }

  return data
    .filter((skill) => typeof skill.name === "string" && skill.name.trim().length > 0)
    .map((skill) => {
      const description =
        typeof skill.description === "string" && skill.description.trim() ? skill.description.trim() : undefined;
      const content = typeof (skill as { content?: unknown }).content === "string" ? (skill as { content: string }).content : "";
      return {
        name: skill.name.trim(),
        description: description ?? (content ? deriveSkillDescription(content) : undefined),
        location: typeof skill.location === "string" && skill.location ? skill.location : undefined,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_CATALOG_SIZE);
}

import fs from "node:fs/promises";
import { opencodeClient } from "../../opencode/client.js";
import { deriveSkillDescription } from "./skill-markdown.js";

export interface SkillCatalogItem {
  name: string;
  description?: string | undefined;
  location?: string | undefined;
  developer?: string | undefined;
  version?: string | undefined;
  updatedAt?: string | undefined;
}

const MAX_CATALOG_SIZE = 200;
const BUILT_IN_LOCATION = "<built-in>";
const BUILT_IN_DEVELOPER = "OpenCode (built-in)";

function normalizeDirectory(projectDirectory: string): string {
  return projectDirectory.replace(/\\/g, "/");
}

/**
 * Extract developer/version from a plugin cache location such as
 * `/.../packages/superpowers@git+https:/github.com/obra/superpowers.git#v6.3.0/node_modules/...`
 * Returns developer `obra/superpowers` and version `v6.3.0`.
 */
function parsePluginLocation(location: string): { developer?: string; version?: string } | undefined {
  const match = /packages\/[^/]+@git\+https?:\/\/?[^/]+\/([^/]+)\/([^/#]+?)(?:\.git)?#([^/]+)/u.exec(location);
  if (!match) {
    return undefined;
  }
  const [, owner, repo, version] = match;
  if (!owner || !repo || !version) {
    return undefined;
  }
  return { developer: `${owner}/${repo}`, version };
}

async function fileUpdatedAt(location: string | undefined): Promise<string | undefined> {
  if (!location || location === BUILT_IN_LOCATION) {
    return undefined;
  }
  const stat = await fs.stat(location).catch(() => null);
  return stat ? stat.mtime.toISOString().slice(0, 10) : undefined;
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

  const items = data
    .filter((skill) => typeof skill.name === "string" && skill.name.trim().length > 0)
    .map((skill) => {
      const description =
        typeof skill.description === "string" && skill.description.trim() ? skill.description.trim() : undefined;
      const content = typeof (skill as { content?: unknown }).content === "string" ? (skill as { content: string }).content : "";
      const location = typeof skill.location === "string" && skill.location ? skill.location : undefined;
      return { skill, description, content, location };
    })
    .sort((left, right) => left.skill.name.localeCompare(right.skill.name))
    .slice(0, MAX_CATALOG_SIZE);

  return Promise.all(
    items.map(async ({ skill, description, content, location }) => {
      let developer: string | undefined;
      let version: string | undefined;
      if (location === BUILT_IN_LOCATION) {
        developer = BUILT_IN_DEVELOPER;
      } else if (location) {
        const plugin = parsePluginLocation(location);
        developer = plugin?.developer;
        version = plugin?.version;
      }

      return {
        name: skill.name.trim(),
        description: description ?? (content ? deriveSkillDescription(content) : undefined),
        location,
        developer,
        version,
        updatedAt: await fileUpdatedAt(location),
      } satisfies SkillCatalogItem;
    }),
  );
}

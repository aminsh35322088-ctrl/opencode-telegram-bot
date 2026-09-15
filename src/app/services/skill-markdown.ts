export interface ParsedSkillMarkdown {
  name?: string | undefined;
  description?: string | undefined;
  body: string;
}

const MAX_DERIVED_DESCRIPTION_LENGTH = 200;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    return { body: content };
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (field && field[1] && field[2] !== undefined) {
      fields[field[1].toLowerCase()] = unquote(field[2]);
    }
  }

  return {
    name: fields.name || undefined,
    description: fields.description || undefined,
    body: content.slice(match[0].length).replace(/^[ \t]*\r?\n/, ""),
  };
}

export function deriveSkillDescription(content: string): string | undefined {
  const parsed = parseSkillMarkdown(content);
  if (parsed.description) {
    return parsed.description;
  }

  const paragraphs = parsed.body
    .split(/\r?\n[ \t\r]*\r?\n/)
    .map((block) => block.trim())
    .filter(
      (block) =>
        block.length > 0 &&
        !block.startsWith("#") &&
        !block.startsWith(">") &&
        !block.startsWith("```") &&
        !block.startsWith("<!--"),
    );

  const first = paragraphs[0];
  if (!first) {
    return undefined;
  }

  const collapsed = first.replace(/\s+/gu, " ");
  if (collapsed.length <= MAX_DERIVED_DESCRIPTION_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_DERIVED_DESCRIPTION_LENGTH)}...`;
}

import { describe, expect, it } from "vitest";
import { deriveSkillDescription, parseSkillMarkdown } from "../../../src/app/services/skill-markdown.js";

describe("app/services/skill-markdown", () => {
  it("parses quoted and unquoted frontmatter fields", () => {
    const parsed = parseSkillMarkdown('---\nname: my-skill\ndescription: "Does: things"\n---\n\n# Body\nText');
    expect(parsed.name).toBe("my-skill");
    expect(parsed.description).toBe("Does: things");
    expect(parsed.body).toContain("# Body");

    const plain = parseSkillMarkdown("---\nname: simple\ndescription: Plain text\n---\n\nContent");
    expect(plain.name).toBe("simple");
    expect(plain.description).toBe("Plain text");
    expect(plain.body).toBe("Content");
  });

  it("returns whole content as body when no frontmatter exists", () => {
    const parsed = parseSkillMarkdown("# Title\n\nParagraph.");
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe("# Title\n\nParagraph.");
  });

  it("derives description from frontmatter first", () => {
    const content = '---\nname: x\ndescription: "From frontmatter"\n---\n\n# X\n\nBody para';
    expect(deriveSkillDescription(content)).toBe("From frontmatter");
  });

  it("derives description from first real paragraph when frontmatter lacks it", () => {
    const content = "# Heading\n\n> not this\n\n```code\nnope\n```\n\nFirst actual paragraph explains\nthe skill.\n\n## Section";
    expect(deriveSkillDescription(content)).toBe("First actual paragraph explains the skill.");
  });

  it("collapses whitespace and truncates long derived descriptions", () => {
    const long = "A".repeat(300);
    const derived = deriveSkillDescription(`# H\n\n${long}`);
    expect(derived).toBeDefined();
    expect(derived!.length).toBeLessThanOrEqual(203);
    expect(derived!.endsWith("...")).toBe(true);
  });

  it("returns undefined when nothing usable exists", () => {
    expect(deriveSkillDescription("# Only heading\n\n## Another")).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const pathsMock = vi.hoisted(() => ({ appHome: "" }));

vi.mock("../../../src/runtime/paths.js", () => ({
  getRuntimePaths: () => ({ appHome: pathsMock.appHome }),
}));

import {
  deleteGlobalSkill,
  isManagedSkillLocation,
  isValidSkillName,
  updateGlobalSkill,
  writeGlobalSkill,
} from "../../../src/app/services/skill-manage-service.js";

describe("app/services/skill-manage-service", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "otb-skill-"));
    pathsMock.appHome = tmpHome;
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("validates skill names", () => {
    expect(isValidSkillName("deploy-check")).toBe(true);
    expect(isValidSkillName("a")).toBe(true);
    expect(isValidSkillName("Deploy-Check")).toBe(false);
    expect(isValidSkillName("-bad")).toBe(false);
    expect(isValidSkillName("bad--name")).toBe(false);
    expect(isValidSkillName("bad_name")).toBe(false);
    expect(isValidSkillName("")).toBe(false);
  });

  it("writes a SKILL.md with frontmatter into the global skills directory", async () => {
    const file = await writeGlobalSkill({
      name: "deploy-check",
      description: 'Use before "any" deploy',
      body: "# Deploy check\n1. run tests",
    });
    expect(file).toBe(path.join(tmpHome, ".config", "opencode", "skills", "deploy-check", "SKILL.md"));
    const content = await fs.readFile(file, "utf8");
    expect(content.startsWith("---\nname: deploy-check\ndescription: \"Use before 'any' deploy\"\n---")).toBe(true);
    expect(content).toContain("# Deploy check");
  });

  it("refuses duplicate skills and empty bodies", async () => {
    await writeGlobalSkill({ name: "solo", description: "d", body: "b" });
    await expect(writeGlobalSkill({ name: "solo", description: "d", body: "b" })).rejects.toThrow("already exists");
    await expect(writeGlobalSkill({ name: "solo2", description: "d", body: "   " })).rejects.toThrow("empty");
  });

  it("overwrites an existing managed skill in place", async () => {
    await writeGlobalSkill({ name: "deploy-check", description: "old desc", body: "# Old" });
    const file = await updateGlobalSkill({
      name: "deploy-check",
      description: "new desc",
      body: "# New body",
    });
    expect(file).toBe(path.join(tmpHome, ".config", "opencode", "skills", "deploy-check", "SKILL.md"));
    const content = await fs.readFile(file, "utf8");
    expect(content.startsWith('---\nname: deploy-check\ndescription: "new desc"\n---')).toBe(true);
    expect(content).toContain("# New body");
    expect(content).not.toContain("# Old");
  });

  it("refuses to update a skill that does not exist", async () => {
    await expect(
      updateGlobalSkill({ name: "ghost", description: "d", body: "b" }),
    ).rejects.toThrow("does not exist");
  });

  it("validates name and content when updating", async () => {
    await writeGlobalSkill({ name: "solo", description: "d", body: "b" });
    await expect(updateGlobalSkill({ name: "Bad Name", description: "d", body: "b" })).rejects.toThrow(
      "Invalid skill name",
    );
    await expect(updateGlobalSkill({ name: "solo", description: "   ", body: "b" })).rejects.toThrow("empty");
    await expect(updateGlobalSkill({ name: "solo", description: "d", body: "   " })).rejects.toThrow("empty");
  });

  it("deletes only managed skills", async () => {
    await writeGlobalSkill({ name: "temp-skill", description: "d", body: "b" });
    expect(isManagedSkillLocation(path.join(tmpHome, ".config", "opencode", "skills", "temp-skill", "SKILL.md"))).toBe(true);
    expect(isManagedSkillLocation("/builtin/customize-opencode.md")).toBe(false);
    expect(isManagedSkillLocation(undefined)).toBe(false);
    expect(await deleteGlobalSkill("temp-skill")).toBe(true);
    expect(await deleteGlobalSkill("temp-skill")).toBe(false);
    expect(await deleteGlobalSkill("../escape")).toBe(false);
    await expect(fs.stat(path.join(tmpHome, ".config", "opencode", "skills", "temp-skill"))).rejects.toThrow();
  });
});

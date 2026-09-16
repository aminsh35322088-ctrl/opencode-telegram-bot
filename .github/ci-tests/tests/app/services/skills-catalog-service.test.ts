import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const skillListMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    app: {
      skills: skillListMock,
    },
  },
}));

import { loadSkillsCatalog } from "../../../src/app/services/skills-catalog-service.js";

describe("app/services/skills-catalog-service", () => {
  let tmpDir: string;

  beforeEach(async () => {
    skillListMock.mockReset();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "otb-catalog-"));
  });

  async function cleanup() {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  it("extracts developer and version from plugin locations and mtime from local files", async () => {
    const localFile = path.join(tmpDir, "SKILL.md");
    await fs.writeFile(localFile, "---\nname: local\ndescription: d\n---\n\nBody", "utf8");
    const stat = await fs.stat(localFile);
    const expectedDate = stat.toISOString().slice(0, 10);

    skillListMock.mockResolvedValue({
      data: [
        {
          name: "brainstorming",
          description: "Explore intent",
          location:
            "/data/.cache/opencode/packages/superpowers@git+https:/github.com/obra/superpowers.git#v6.3.0/node_modules/superpowers/skills/brainstorming/SKILL.md",
          content: "",
        },
        { name: "customize-opencode", description: "Config", location: "<built-in>", content: "" },
        { name: "local", description: "d", location: localFile, content: "" },
      ],
      error: null,
    });

    const skills = await loadSkillsCatalog("D:\\Projects\\Repo");
    await cleanup();

    expect(skills[0]).toMatchObject({
      name: "brainstorming",
      developer: "obra/superpowers",
      version: "v6.3.0",
    });
    expect(skills[1]).toMatchObject({ name: "customize-opencode", developer: "OpenCode (built-in)" });
    expect(skills[1]?.updatedAt).toBeUndefined();
    expect(skills[2]).toMatchObject({ name: "local", developer: undefined, updatedAt: expectedDate });
  });

  it("leaves developer and updatedAt undefined for unknown locations", async () => {
    skillListMock.mockResolvedValue({
      data: [{ name: "mystery", description: "d", location: "/some/other/place/SKILL.md", content: "" }],
      error: null,
    });

    const skills = await loadSkillsCatalog("/tmp/proj");
    await cleanup();
    expect(skills[0]).toMatchObject({ name: "mystery", developer: undefined, updatedAt: undefined });
  });
});

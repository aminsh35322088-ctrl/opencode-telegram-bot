import { describe, expect, it, vi } from "vitest";
import {
  fetchSkillFromGitHub,
  isAllowedGitHubUrl,
  parseGitHubSkillUrl,
  resolveSkillSource,
} from "../../../src/app/services/skill-import-service.js";

type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

function fakeFetch(routes: Record<string, string>): { fetchFn: FetchFn; called: string[] } {
  const called: string[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const fetchFn: FetchFn = async (url) => {
    called.push(url);
    const key = keys.find((candidate) => url.startsWith(candidate));
    if (!key) return { ok: false, status: 404, text: async () => "Not Found" };
    return { ok: true, status: 200, text: async () => routes[key] };
  };
  return { fetchFn, called };
}

const SKILL_MD = "---\nname: my-skill\ndescription: Does great things\n---\n\n# Body";

describe("app/services/skill-import-service", () => {
  it("classifies allowed GitHub hosts and rejects others", () => {
    expect(isAllowedGitHubUrl("https://github.com/owner/repo")).toBe(true);
    expect(isAllowedGitHubUrl("https://raw.githubusercontent.com/owner/repo/main/SKILL.md")).toBe(true);
    expect(isAllowedGitHubUrl("https://gist.github.com/owner/abc")).toBe(false);
    expect(isAllowedGitHubUrl("https://evil.com/github.com/owner/repo")).toBe(false);
    expect(isAllowedGitHubUrl("not a url")).toBe(false);
  });

  it("parses repo, tree, and blob URLs into owner/repo/ref/path", () => {
    expect(parseGitHubSkillUrl("https://github.com/owner/repo")).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: undefined,
      subpath: undefined,
    });
    expect(parseGitHubSkillUrl("https://github.com/owner/repo/tree/main/skills/my-skill")).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "main",
      subpath: "skills/my-skill",
    });
    expect(parseGitHubSkillUrl("https://github.com/owner/repo/blob/v2.0.0/skills/my-skill/SKILL.md")).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "v2.0.0",
      subpath: "skills/my-skill/SKILL.md",
    });
    expect(parseGitHubSkillUrl("https://github.com/owner/repo.git")).toMatchObject({ owner: "owner", repo: "repo" });
    expect(parseGitHubSkillUrl("https://github.com/owner/repo/../evil")).toBeNull();
  });

  it("fetches a direct SKILL.md blob link pinned to a commit sha", async () => {
    const { fetchFn, called } = fakeFetch({
      "https://api.github.com/repos/owner/repo/commits/main": JSON.stringify({ sha: "deadbeef" }),
      "https://raw.githubusercontent.com/owner/repo/deadbeef/skills/my-skill/SKILL.md": SKILL_MD,
    });

    const result = await fetchSkillFromGitHub(
      "https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md",
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("Does great things");
    expect(result.content).toBe(SKILL_MD);
    expect(called.some((u) => u.includes("deadbeef"))).toBe(true);
  });

  it("resolves a repo root through the default branch", async () => {
    const { fetchFn } = fakeFetch({
      "https://api.github.com/repos/owner/repo": JSON.stringify({ default_branch: "trunk" }),
      "https://api.github.com/repos/owner/repo/commits/trunk": JSON.stringify({ sha: "abc123" }),
      "https://raw.githubusercontent.com/owner/repo/abc123/SKILL.md": SKILL_MD,
    });

    const result = await fetchSkillFromGitHub("https://github.com/owner/repo", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.name).toBe("my-skill");
  });

  it("returns a single resolution for a folder containing SKILL.md", async () => {
    const { fetchFn } = fakeFetch({
      "https://api.github.com/repos/owner/repo/commits/main": JSON.stringify({ sha: "s0" }),
      "https://raw.githubusercontent.com/owner/repo/s0/skills/plain/SKILL.md": SKILL_MD,
    });

    const resolved = await resolveSkillSource("https://github.com/owner/repo/tree/main/skills/plain", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(resolved.kind).toBe("single");
  });

  it("lists multiple skills when a folder has no SKILL.md but skill subfolders do", async () => {
    const { fetchFn } = fakeFetch({
      "https://api.github.com/repos/owner/repo/commits/main": JSON.stringify({ sha: "m1" }),
      "https://api.github.com/repos/owner/repo/contents/skills": JSON.stringify([
        { name: "alpha", path: "skills/alpha", type: "dir" },
        { name: "beta", path: "skills/beta", type: "dir" },
        { name: "README.md", path: "skills/README.md", type: "file" },
      ]),
      "https://api.github.com/repos/owner/repo/contents/skills/alpha": JSON.stringify([
        { name: "notes.txt", path: "skills/alpha/notes.txt", type: "file" },
      ]),
      "https://api.github.com/repos/owner/repo/contents/skills/beta": JSON.stringify([
        { name: "SKILL.md", path: "skills/beta/SKILL.md", type: "file" },
      ]),
    });

    const resolved = await resolveSkillSource("https://github.com/owner/repo/tree/main/skills", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(resolved).toEqual({
      kind: "list",
      candidates: [{ name: "beta", url: "https://github.com/owner/repo/tree/main/skills/beta" }],
    });
  });

  it("prefers the directory name over a mismatching frontmatter name", async () => {
    const { fetchFn } = fakeFetch({
      "https://api.github.com/repos/owner/repo/commits/main": JSON.stringify({ sha: "s1" }),
      "https://raw.githubusercontent.com/owner/repo/s1/tools/weird-name/SKILL.md":
        "---\nname: totally-different\ndescription: x\n---\n\nBody",
    });

    const result = await fetchSkillFromGitHub(
      "https://github.com/owner/repo/tree/main/tools/weird-name",
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result.name).toBe("weird-name");
  });

  it("falls back to the first body paragraph when frontmatter has no description", async () => {
    const { fetchFn } = fakeFetch({
      "https://api.github.com/repos/owner/repo/commits/main": JSON.stringify({ sha: "s2" }),
      "https://raw.githubusercontent.com/owner/repo/s2/skills/plain/SKILL.md":
        "---\nname: plain\n---\n\n# Plain\n\nExplains what this does.",
    });

    const result = await fetchSkillFromGitHub(
      "https://github.com/owner/repo/tree/main/skills/plain",
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result.description).toBe("Explains what this does.");
  });

  it("rejects non-GitHub and missing SKILL.md sources", async () => {
    const { fetchFn } = fakeFetch({});
    await expect(
      fetchSkillFromGitHub("https://example.com/skill", { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow(/GitHub/);

    const { fetchFn: missingFn } = fakeFetch({
      "https://api.github.com/repos/owner/repo/commits/main": JSON.stringify({ sha: "s3" }),
      "https://api.github.com/repos/owner/repo/contents/nothing": JSON.stringify([
        { name: "x.txt", path: "nothing/x.txt", type: "file" },
      ]),
    });
    await expect(
      fetchSkillFromGitHub("https://github.com/owner/repo/tree/main/nothing", {
        fetchFn: missingFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/SKILL\.md/);
  });

  it("rejects oversized skill files", async () => {
    const huge = "x".repeat(300_000);
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: true, status: 200, text: async () => huge }));
    await expect(
      fetchSkillFromGitHub("https://raw.githubusercontent.com/owner/repo/main/SKILL.md", {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/too large/);
  });
});

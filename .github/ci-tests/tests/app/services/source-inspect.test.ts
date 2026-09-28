import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: { token: "123456:source-inspect", allowedUserId: 1 },
    opencode: {
      apiUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "",
      autoRestartEnabled: false,
      monitorIntervalSec: 20,
      model: { provider: "opencode", modelId: "test-model" },
    },
  },
}));

const resolveSkillSource = vi.hoisted(() => vi.fn());
const analyzeRemoteMcpEndpoint = vi.hoisted(() => vi.fn());

vi.mock("../../../src/app/services/skill-import-service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/app/services/skill-import-service.js")>(
    "../../../src/app/services/skill-import-service.js",
  );
  return { ...actual, resolveSkillSource };
});

vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  analyzeRemoteMcpEndpoint,
}));

import { inspectExtensionSource } from "../../../src/app/services/source-inspect-service.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ROOT_LISTING = [
  { type: "file", name: "README.md" },
  { type: "file", name: "package.json", url: "https://api.github.com/pkg" },
  { type: "dir", name: "src" },
];

describe("extension source inspection", () => {
  // The suite config restores mocks before every test, so the fetch spy has to
  // be installed per test rather than once for the describe block.
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolveSkillSource.mockReset();
    analyzeRemoteMcpEndpoint.mockReset();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /** Routes by URL so assertions do not depend on call order. */
  function routeFetch(routes: Array<[RegExp, () => Response]>): void {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const match = routes.find(([pattern]) => pattern.test(url));
      if (!match) throw new Error(`Unexpected fetch: ${url}`);
      return match[1]();
    });
  }

  it("classifies a pinned npm plugin specifier without any network call", async () => {
    const result = await inspectExtensionSource("left-pad@1.3.0");
    expect(result).toMatchObject({ kind: "plugin", specifier: "left-pad@1.3.0", name: "left-pad" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("classifies a pinned git plugin specifier", async () => {
    const result = await inspectExtensionSource("superpowers@git+https://github.com/obra/superpowers.git#v6.4.2");
    expect(result.kind).toBe("plugin");
    expect(result.specifier).toBe("superpowers@git+https://github.com/obra/superpowers.git#v6.4.2");
  });

  it("rejects an unpinned npm specifier as a plugin and falls through to MCP/unknown", async () => {
    analyzeRemoteMcpEndpoint.mockResolvedValue({ url: "x", reachable: false, status: null, authHint: "none-or-unknown", note: "down" });
    const result = await inspectExtensionSource("some-plugin@latest");
    // "latest" is not a valid immutable pin, so it must not be reported as a plugin.
    expect(result.kind).not.toBe("plugin");
  });

  it("detects an OpenCode plugin repository and resolves an immutable commit", async () => {
    routeFetch([
      [/\/contents\?/, () => jsonResponse(ROOT_LISTING)],
      [/\/pkg$/, () => jsonResponse({ name: "superpowers", description: "Reusable skills." })],
      [/\/commits\//, () => jsonResponse({ sha: "a".repeat(40) })],
    ]);

    const result = await inspectExtensionSource("https://github.com/obra/superpowers");
    expect(result).toMatchObject({
      kind: "plugin",
      name: "superpowers",
      description: "Reusable skills.",
      specifier: `superpowers@git+https://github.com/obra/superpowers.git#${"a".repeat(40)}`,
    });
    expect(result.meta).toMatchObject({ owner: "obra", commit: "a".repeat(40) });
    // A plugin brings its own skills, so skill resolution must not be attempted.
    expect(resolveSkillSource).not.toHaveBeenCalled();
  });

  it("warns when a plugin commit cannot be resolved so it cannot be installed unverified", async () => {
    routeFetch([
      [/\/contents\?/, () => jsonResponse(ROOT_LISTING)],
      [/\/pkg$/, () => jsonResponse({ name: "pkg" })],
      [/\/commits\//, () => jsonResponse({ message: "Not Found" }, 404)],
    ]);

    const result = await inspectExtensionSource("https://github.com/owner/repo");
    expect(result.kind).toBe("plugin");
    expect(result.note).toMatch(/pin a tag or commit/);
  });

  it("falls back to skill detection when the repository is not a plugin", async () => {
    routeFetch([[/\/contents\?/, () => jsonResponse([{ type: "file", name: "README.md" }])]]);
    resolveSkillSource.mockResolvedValue({
      kind: "single",
      skill: { name: "brainstorming", description: "Design before coding.", content: "x", sourceUrl: "u" },
    });

    const result = await inspectExtensionSource("https://github.com/obra/superpowers");
    expect(result).toMatchObject({ kind: "skill", name: "brainstorming", description: "Design before coding." });
  });

  it("summarizes a repository containing many skills", async () => {
    routeFetch([[/\/contents\?/, () => jsonResponse([{ type: "file", name: "README.md" }])]]);
    resolveSkillSource.mockResolvedValue({
      kind: "list",
      candidates: [{ name: "brainstorming", url: "u1" }, { name: "systematic-debugging", url: "u2" }],
    });

    const result = await inspectExtensionSource("https://github.com/obra/superpowers");
    expect(result.kind).toBe("skill");
    expect(result.meta).toMatchObject({ skillCount: 2 });
    expect(result.description).toContain("brainstorming");
    expect(result.note).toMatch(/folder URL/);
  });

  it("reports unknown when a repository is neither plugin nor skill", async () => {
    routeFetch([[/\/contents\?/, () => jsonResponse([{ type: "file", name: "README.md" }])]]);
    resolveSkillSource.mockRejectedValue(new Error("No SKILL.md found in this location"));

    const result = await inspectExtensionSource("https://github.com/owner/plain-repo");
    expect(result.kind).toBe("unknown");
    expect(result.note).toMatch(/No OpenCode plugin manifest/);
  });

  it("classifies a reachable MCP endpoint and reports its auth requirement", async () => {
    analyzeRemoteMcpEndpoint.mockResolvedValue({
      url: "https://mcp.example/mcp",
      reachable: true,
      status: 401,
      authHint: "oauth-likely",
      note: "OAuth metadata advertised.",
    });

    const result = await inspectExtensionSource("https://mcp.example/mcp");
    expect(result).toMatchObject({ kind: "mcp", specifier: "https://mcp.example/mcp" });
    expect(result.description).toMatch(/OAuth/);
    expect(result.meta).toMatchObject({ status: 401, auth: "oauth-likely" });
  });

  it("still reports an unreachable endpoint as MCP with the probe note", async () => {
    analyzeRemoteMcpEndpoint.mockRejectedValue(new Error("fetch failed"));
    const result = await inspectExtensionSource("https://down.example/mcp");
    expect(result.kind).toBe("mcp");
    expect(result.note).toMatch(/not reachable/);
  });

  it("rejects an empty source", async () => {
    await expect(inspectExtensionSource("   ")).rejects.toThrow(/required/);
  });

  it("returns unknown with guidance for unparsable input", async () => {
    const result = await inspectExtensionSource("just some text");
    expect(result.kind).toBe("unknown");
    expect(result.note).toMatch(/pinned plugin specifier/);
  });

  it("returns unknown for an unsupported URL scheme", async () => {
    const result = await inspectExtensionSource("ftp://example.com/thing");
    expect(result).toMatchObject({ kind: "unknown" });
    expect(result.note).toMatch(/Unsupported URL scheme/);
  });
});

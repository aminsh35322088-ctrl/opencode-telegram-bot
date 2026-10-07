import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@opencode-ai/plugin", () => {
  const field = {
    optional() {
      return this;
    },
    describe() {
      return this;
    },
  };
  return {
    tool: Object.assign((definition: unknown) => definition, {
      schema: { enum: () => field, string: () => field, number: () => field },
    }),
  };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(() => {
    throw Error("raw process forbidden");
  }),
}));
const names = [
  "browser",
  "image-inspect",
  "database-query",
  "system-diagnostics",
  "monitoring",
  "security",
  "git",
  "test",
  "github-ci",
  "full-diagnostics",
];
let directory: string;
beforeEach(async () => {
  vi.stubEnv("AGENT_BOT_DIST_ROOT", path.resolve("dist"));
  directory = await mkdtemp(path.join(os.tmpdir(), "core-tool-"));
});
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function tool(name: string) {
  return (await import(`../../.opencode/tools/${name}.ts`)).default;
}
function context(port?: unknown) {
  return {
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    process: port,
  };
}
const actions = [
  "open",
  "goto",
  "back",
  "forward",
  "reload",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "type",
  "press",
  "hover",
  "check",
  "uncheck",
  "select",
  "close",
  "tab-list",
  "tab-new",
  "tab-select",
  "tab-close",
  "requests",
  "console",
  "pdf",
];
it.each(actions)(
  "browser %s retains action/schema under captured browser authority",
  async (action) => {
    const browser = vi
      .fn()
      .mockResolvedValue({ stdout: " owned ", stderr: "" });
    const args = {
      action,
      url: "https://example.test",
      ref: "e1",
      text: "1",
      session: " named ",
      filename: "artifacts/out.bin",
    };
    expect(
      await (
        await tool("browser")
      ).execute(args, context({ browser, execFile: vi.fn() })),
    ).toBe("owned");
    expect(browser).toHaveBeenCalledOnce();
    expect(browser.mock.calls[0]![0]).toMatchObject({
      action,
      session: "named",
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (["screenshot", "pdf"].includes(action))
      expect(browser.mock.calls[0]![0].filename).toBe(args.filename);
    expect(browser.mock.calls[0]![0].args).not.toContain(
      "--filename=" + path.join(directory, args.filename),
    );
  },
);
it("browser missing ownership creates no output directory", async () => {
  await expect(
    (await tool("browser")).execute(
      { action: "screenshot", filename: "never/out.png" },
      context(),
    ),
  ).rejects.toThrow(/capability|ownership/i);
  await expect(access(path.join(directory, "never"))).rejects.toThrow();
});
it.each(names.filter((n) => n !== "browser"))(
  "%s missing capability fails before helpers can spawn",
  async (name) => {
    await expect(
      (await tool(name)).execute({ action: "summary" }, context()),
    ).rejects.toThrow(/capability|ownership/i);
  },
);
it("image subprocess carries exact captured authority, args, timeout and cancellation", async () => {
  const execFile = vi
    .fn()
    .mockResolvedValue({ stdout: " Format: PNG", stderr: "" });
  const ctx = context({ execFile, browser: vi.fn() });
  await (
    await tool("image-inspect")
  ).execute({ action: "inspect", path: "pic.png" }, ctx);
  expect(execFile).toHaveBeenCalledWith(
    "identify",
    ["-verbose", path.join(directory, "pic.png")],
    expect.objectContaining({
      cwd: directory,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      signal: ctx.abort,
    }),
  );
});
it("database subprocess uses invocation port after filesystem validation", async () => {
  await writeFile(path.join(directory, "data.db"), "");
  const execFile = vi.fn().mockResolvedValue({ stdout: "[]", stderr: "" });
  await (
    await tool("database-query")
  ).execute(
    { action: "query", database: "data.db", query: "select 1" },
    context({ execFile, browser: vi.fn() }),
  );
  expect(execFile).toHaveBeenCalledWith(
    "sqlite3",
    ["-header", "-json", path.join(directory, "data.db"), "select 1"],
    expect.objectContaining({ cwd: directory, timeout: 30000 }),
  );
});
it("helper subprocess calls preserve the captured port across concurrent invocations", async () => {
  const a = vi.fn().mockResolvedValue({ stdout: "A", stderr: "" }),
    b = vi.fn().mockResolvedValue({ stdout: "B", stderr: "" });
  const t = await tool("system-diagnostics");
  await Promise.all([
    t.execute(
      { action: "processes" },
      context({ execFile: a, browser: vi.fn() }),
    ),
    t.execute({ action: "disk" }, context({ execFile: b, browser: vi.fn() })),
  ]);
  expect(a.mock.calls[0]![0]).toBe("ps");
  expect(b.mock.calls[0]![0]).toBe("df");
});
it("revoked capability cannot fall back to raw subprocesses", async () => {
  const execFile = vi
    .fn()
    .mockRejectedValue(Error("captured authority retired"));
  await expect(
    (await tool("image-inspect")).execute(
      { action: "inspect", path: "x" },
      context({ execFile, browser: vi.fn() }),
    ),
  ).rejects.toThrow("captured authority retired");
  expect(execFile).toHaveBeenCalledOnce();
});
it.each([
  "git",
  "test",
  "security",
  "github-ci",
  "monitoring",
  "full-diagnostics",
])("%s helper chain executes through captured port", async (name) => {
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "exit 0" } }),
  );
  const execFile = vi
    .fn()
    .mockResolvedValue({
      stdout: name === "security" ? "{}" : "[]",
      stderr: "",
    });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "{}" }),
  );
  const args: Record<string, unknown> = {
    git: { action: "status" },
    test: { action: "test" },
    security: { action: "audit" },
    "github-ci": { action: "jobs", repo: "example/project", runId: "1" },
    monitoring: { action: "health" },
    "full-diagnostics": { action: "full" },
  }[name]!;
  await (
    await tool(name)
  ).execute(args, context({ execFile, browser: vi.fn() }));
  expect(execFile).toHaveBeenCalled();
  const command = {
    git: "git",
    test: "npm",
    security: "npm",
    "github-ci": "gh",
    monitoring: "node",
    "full-diagnostics": "df",
  }[name];
  expect(execFile.mock.calls.some((call) => call[0] === command)).toBe(true);
  vi.unstubAllGlobals();
});
it("browser retired captured authority rejects without raw or filesystem fallback", async () => {
  const browser = vi.fn().mockRejectedValue(Error("workspace retired"));
  await expect(
    (await tool("browser")).execute(
      { action: "pdf", filename: "never/output.pdf" },
      context({ browser, execFile: vi.fn() }),
    ),
  ).rejects.toThrow("workspace retired");
  await expect(access(path.join(directory, "never"))).rejects.toThrow();
  expect(browser).toHaveBeenCalledOnce();
});

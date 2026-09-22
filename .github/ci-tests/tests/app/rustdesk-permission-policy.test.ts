import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function repoRoot(): Promise<string> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    try {
      await readFile(path.join(dir, "opencode.json"), "utf8");
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error("Unable to locate repository opencode.json");
}

async function readPermission(): Promise<Record<string, unknown>> {
  const root = await repoRoot();
  const config = JSON.parse(await readFile(path.join(root, "opencode.json"), "utf8")) as {
    permission?: Record<string, unknown>;
  };
  return config.permission ?? {};
}

describe("rustdesk permission policy", () => {
  it("asks before nested rustdesk tool actions instead of auto-allowing them", async () => {
    const permission = await readPermission();
    expect(permission["rustdesk.*"]).toBe("ask");
  });

  it("keeps the top-level rustdesk tool allowed for invocation", async () => {
    const permission = await readPermission();
    expect(permission["rustdesk"]).toBe("allow");
  });

  it("places rustdesk.* after rustdesk so last-match-wins prefers ask", async () => {
    const permission = await readPermission();
    const keys = Object.keys(permission);
    expect(keys.indexOf("rustdesk.*")).toBeGreaterThan(keys.indexOf("rustdesk"));
    expect(keys.indexOf("rustdesk")).toBeGreaterThan(keys.indexOf("*"));
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listManagedMcpServers,
  loadManagedMcpServer,
  saveManagedMcpServer,
} from "../../../src/app/services/mcp-server-store.js";

describe("mcp server store", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-server-store-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("persists normalized remote definitions without secret-bearing fields", async () => {
    await saveManagedMcpServer({
      projectDirectory: "C:\\work\\repo\\",
      name: " secure ",
      config: {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer must-not-persist" },
        oauth: false,
      } as never,
    });

    const stateText = await fs.readFile(path.join(home, "app-state.json"), "utf8");
    expect(stateText).not.toContain("must-not-persist");
    expect(stateText).not.toContain("Authorization");

    await expect(loadManagedMcpServer("C:/work/repo", "secure")).resolves.toEqual({
      projectDirectory: "C:/work/repo",
      name: "secure",
      config: { type: "remote", url: "https://mcp.example.com/mcp" },
    });
  });

  it("normalizes local command, cwd, environment, and timeout", async () => {
    await saveManagedMcpServer({
      projectDirectory: "/work/repo/",
      name: "local",
      config: {
        type: "local",
        command: [" node ", "", "server.js", " padded "],
        cwd: " ./tools ",
        environment: { " NODE_ENV ": "test", "": "ignored" },
        timeout: 1234.4,
      },
    });

    await expect(loadManagedMcpServer("/work/repo", "local")).resolves.toEqual({
      projectDirectory: "/work/repo",
      name: "local",
      config: {
        type: "local",
        command: ["node", "", "server.js", " padded "],
        cwd: "./tools",
        environment: { NODE_ENV: "test" },
        timeout: 1234,
      },
    });
  });

  it("isolates definitions by project and supports filtered listing", async () => {
    await saveManagedMcpServer({
      projectDirectory: "/work/a",
      name: "same",
      config: { type: "remote", url: "https://a.example/mcp" },
    });
    await saveManagedMcpServer({
      projectDirectory: "/work/b",
      name: "same",
      config: { type: "remote", url: "https://b.example/mcp" },
    });

    await expect(listManagedMcpServers("/work/a")).resolves.toEqual([
      expect.objectContaining({ projectDirectory: "/work/a", name: "same" }),
    ]);
    await expect(listManagedMcpServers()).resolves.toHaveLength(2);
  });


});

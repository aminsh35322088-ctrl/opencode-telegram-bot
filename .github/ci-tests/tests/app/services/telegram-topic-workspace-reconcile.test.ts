import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { reconcileTopicWorkspaces } from "../../../src/app/services/telegram-topic-workspace-service.js";

describe("telegram-topic-workspace-service reconcile", () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(async () => {
    previous = process.env.OPENCODE_TOPIC_WORKSPACES_DIR;
    root = await mkdtemp(path.join(os.tmpdir(), "topic-workspace-reconcile-"));
    process.env.OPENCODE_TOPIC_WORKSPACES_DIR = root;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.OPENCODE_TOPIC_WORKSPACES_DIR;
    else process.env.OPENCODE_TOPIC_WORKSPACES_DIR = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  async function makeWorkspace(chatId: number, sessionId: string): Promise<string> {
    const dir = path.join(root, String(chatId), sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "README.md"), "# workspace\n", "utf-8");
    return dir;
  }

  it("deletes orphaned workspace directories and keeps referenced ones", async () => {
    const live = await makeWorkspace(100, "sess-live");
    const orphan = await makeWorkspace(100, "sess-orphan");
    const orphanOtherChat = await makeWorkspace(200, "sess-old");

    const removed = await reconcileTopicWorkspaces(new Set([live]));

    expect(removed.sort()).toEqual([orphan, orphanOtherChat].sort());
    expect(existsSync(live)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(orphanOtherChat)).toBe(false);
    // The emptied chat directory is pruned as well.
    expect(existsSync(path.join(root, "200"))).toBe(false);
  });

  it("removes nothing when every directory is referenced", async () => {
    const a = await makeWorkspace(100, "sess-a");
    const b = await makeWorkspace(100, "sess-b");

    const removed = await reconcileTopicWorkspaces(new Set([a, b]));

    expect(removed).toEqual([]);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it("ignores unmanaged directories outside the workspace root", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "topic-workspace-outside-"));
    try {
      await makeWorkspace(100, "sess-orphan");
      const removed = await reconcileTopicWorkspaces(new Set([outside]));
      expect(removed).toHaveLength(1);
      expect(existsSync(outside)).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("is a no-op when the workspace root does not exist yet", async () => {
    await rm(root, { recursive: true, force: true });
    const removed = await reconcileTopicWorkspaces(new Set());
    expect(removed).toEqual([]);
  });
});

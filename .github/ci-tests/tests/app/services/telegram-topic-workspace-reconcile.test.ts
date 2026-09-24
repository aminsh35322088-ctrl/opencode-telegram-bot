import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  deleteTelegramTopicWorkspace,
  isTelegramTopicWorkspace,
  reconcileTopicWorkspaces,
} from "../../../src/app/services/telegram-topic-workspace-service.js";

describe("telegram-topic-workspace-service reconcile", () => {
  let root: string;
  let appHome: string;
  let previous: string | undefined;
  let previousHome: string | undefined;

  beforeEach(async () => {
    previous = process.env.OPENCODE_TOPIC_WORKSPACES_DIR;
    previousHome = process.env.OPENCODE_TELEGRAM_HOME;
    appHome = await mkdtemp(path.join(os.tmpdir(), "topic-workspace-home-"));
    root = path.join(appHome, "opencode", "topic-workspaces");
    process.env.OPENCODE_TOPIC_WORKSPACES_DIR = root;
    process.env.OPENCODE_TELEGRAM_HOME = appHome;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.OPENCODE_TOPIC_WORKSPACES_DIR;
    else process.env.OPENCODE_TOPIC_WORKSPACES_DIR = previous;
    if (previousHome === undefined) delete process.env.OPENCODE_TELEGRAM_HOME;
    else process.env.OPENCODE_TELEGRAM_HOME = previousHome;
    await rm(appHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

  it("reconciles legacy persistent-root workspaces without touching referenced current workspaces", async () => {
    const live = await makeWorkspace(100, "sess-live");
    const legacy = path.join(appHome, "topic-workspaces", "100", "sess-legacy");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "README.md"), "# legacy\n", "utf-8");

    expect(isTelegramTopicWorkspace(legacy)).toBe(true);

    const removed = await reconcileTopicWorkspaces(new Set([live]));

    expect(removed).toContain(legacy);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it("deletes a legacy workspace through the same guarded delete API", async () => {
    const legacy = path.join(appHome, "topic-workspaces", "100", "sess-legacy");
    const outside = path.join(appHome, "outside", "100", "sess");
    await mkdir(legacy, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(legacy, "README.md"), "# legacy\n", "utf-8");
    await writeFile(path.join(outside, "README.md"), "# outside\n", "utf-8");

    await expect(deleteTelegramTopicWorkspace(legacy)).resolves.toBeUndefined();
    await expect(deleteTelegramTopicWorkspace(outside)).rejects.toThrow(/refusing to delete/i);

    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  it("keeps path guards strict across current and legacy roots", async () => {
    const validLegacy = path.join(appHome, "topic-workspaces", "100", "sess-legacy");
    const malformedLegacy = path.join(appHome, "topic-workspaces", "not-a-chat", "sess");
    const tooDeepLegacy = path.join(appHome, "topic-workspaces", "100", "sess", "nested");
    const outside = path.join(appHome, "unmanaged", "100", "sess");

    expect(isTelegramTopicWorkspace(validLegacy)).toBe(true);
    expect(isTelegramTopicWorkspace(malformedLegacy)).toBe(false);
    expect(isTelegramTopicWorkspace(tooDeepLegacy)).toBe(false);
    expect(isTelegramTopicWorkspace(outside)).toBe(false);
  });

  it("is a no-op when the workspace roots do not exist yet", async () => {
    await rm(root, { recursive: true, force: true });
    await rm(path.join(appHome, "topic-workspaces"), { recursive: true, force: true });
    const removed = await reconcileTopicWorkspaces(new Set());
    expect(removed).toEqual([]);
  });
});

import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findTelegramTopicBindingByDirectory,
  findTelegramTopicBindingsByDirectory,
  listTelegramTopicBindings,
  saveTelegramTopicBinding,
  updateTelegramTopicBinding,
  type TelegramTopicBinding,
} from "../../../src/app/services/telegram-topic-store.js";

type BindingInput = Parameters<typeof saveTelegramTopicBinding>[0];

function makeBinding(overrides: Partial<BindingInput> = {}): BindingInput {
  return {
    bindingId: "binding-a",
    chatId: 100,
    threadId: 11,
    sessionId: "session-a",
    directory: "/workspace/",
    bindingGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("telegram topic binding identity", () => {
  let appHome: string;
  let previousHome: string | undefined;
  let previousRuntimeMode: string | undefined;
  let storePath: string;

  beforeEach(async () => {
    previousHome = process.env.OPENCODE_TELEGRAM_HOME;
    previousRuntimeMode = process.env.OPENCODE_TELEGRAM_RUNTIME_MODE;
    appHome = await mkdtemp(path.join(os.tmpdir(), "topic-binding-identity-"));
    process.env.OPENCODE_TELEGRAM_HOME = appHome;
    process.env.OPENCODE_TELEGRAM_RUNTIME_MODE = "installed";
    storePath = path.join(appHome, "runtime", "topics", "telegram-topic-bindings.json");
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.OPENCODE_TELEGRAM_HOME;
    else process.env.OPENCODE_TELEGRAM_HOME = previousHome;
    if (previousRuntimeMode === undefined) delete process.env.OPENCODE_TELEGRAM_RUNTIME_MODE;
    else process.env.OPENCODE_TELEGRAM_RUNTIME_MODE = previousRuntimeMode;
    await rm(appHome, { recursive: true, force: true });
  });

  async function writeStore(records: unknown[]): Promise<void> {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(records), "utf8");
  }

  async function readStore(): Promise<Record<string, unknown>[]> {
    return JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>[];
  }

  it("migrates legacy records with a stable binding ID and generation", async () => {
    await writeStore([{
      chatId: 100,
      threadId: 11,
      sessionId: "legacy-session",
      directory: "C:\\Work\\Project\\",
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);

    const first = await listTelegramTopicBindings();
    const second = await listTelegramTopicBindings();

    expect(first).toHaveLength(1);
    expect(first[0]?.bindingId).toEqual(expect.any(String));
    expect(first[0]?.bindingId).not.toBe("");
    expect(first[0]?.bindingGeneration).toBe(1);
    expect(first[0]?.directory).toBe("c:/work/project");
    expect(second).toEqual(first);
  });

  it("accepts legacy-shaped writes and persists canonical identity", async () => {
    await saveTelegramTopicBinding({
      chatId: 100,
      threadId: 11,
      sessionId: "legacy-write",
      directory: "/Workspace/",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as BindingInput);

    const [saved] = await listTelegramTopicBindings();
    const persisted = await readStore();

    expect(saved?.bindingId).toEqual(expect.any(String));
    expect(saved?.bindingGeneration).toBe(1);
    expect(saved?.directory).toBe("/workspace");
    expect(persisted[0]?.bindingId).toBe(saved?.bindingId);
    expect(persisted[0]?.bindingGeneration).toBe(1);
  });

  it("normalizes directories for lookups", async () => {
    await saveTelegramTopicBinding(makeBinding({ directory: "C:\\Work\\Project\\" }));

    const single = await findTelegramTopicBindingByDirectory("c:/work/project/");
    const many = await findTelegramTopicBindingsByDirectory("C:/WORK/PROJECT");

    expect(single?.directory).toBe("c:/work/project");
    expect(many).toEqual([single]);
  });

  it("preserves binding ID and generation across updates and writes", async () => {
    await saveTelegramTopicBinding(makeBinding({ bindingId: "binding-a", bindingGeneration: 7 }));

    await updateTelegramTopicBinding(100, 11, {
      directory: "C:\\Other\\Path\\",
      title: "Updated",
    });
    const updated = await findTelegramTopicBindingByDirectory("c:/other/path");
    expect(updated?.bindingId).toBe("binding-a");
    expect(updated?.bindingGeneration).toBe(7);
    expect(updated?.directory).toBe("c:/other/path");

    await saveTelegramTopicBinding({ ...(updated as TelegramTopicBinding), title: "Updated again" });
    const persisted = await readStore();
    expect(persisted[0]).toMatchObject({ bindingId: "binding-a", bindingGeneration: 7, directory: "c:/other/path" });
  });

  it("rejects a duplicate session ID across bindings", async () => {
    await saveTelegramTopicBinding(makeBinding({ sessionId: "shared-session" }));

    await expect(saveTelegramTopicBinding(makeBinding({
      bindingId: "binding-b",
      chatId: 200,
      threadId: 22,
      sessionId: "shared-session",
      directory: "/other",
    }))).rejects.toThrow(/duplicate session/i);
  });

  it("rejects a duplicate chat and thread identity", async () => {
    await saveTelegramTopicBinding(makeBinding({ sessionId: "session-a" }));

    await expect(saveTelegramTopicBinding(makeBinding({
      bindingId: "binding-b",
      sessionId: "session-b",
      directory: "/other",
    }))).rejects.toThrow(/duplicate.*thread|thread.*duplicate/i);
  });

  it("rejects reuse of a binding ID for a different route", async () => {
    await saveTelegramTopicBinding(makeBinding({ bindingId: "binding-a" }));

    await expect(saveTelegramTopicBinding(makeBinding({
      bindingId: "binding-a",
      threadId: 22,
      sessionId: "session-b",
      directory: "/other",
    }))).rejects.toThrow(/binding.*already|duplicate.*binding/i);
  });

  it("throws when updating a missing binding", async () => {
    await expect(updateTelegramTopicBinding(100, 99, { title: "missing" })).rejects.toThrow(/binding/i);
  });
});

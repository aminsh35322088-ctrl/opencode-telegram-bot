import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  registerCoreTopicBinding: vi.fn(),
  rotateCoreTopicBinding: vi.fn(),
  failBindingWrite: false,
}));

vi.mock("../../../src/core/native-core-service.js", () => ({
  registerCoreTopicBinding: mocked.registerCoreTopicBinding,
  rotateCoreTopicBinding: mocked.rotateCoreTopicBinding,
}));

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const target = String(args[0]);
      if (mocked.failBindingWrite && target.endsWith("telegram-topic-bindings.json.tmp")) {
        throw new Error("simulated binding metadata write failure");
      }
      return actual.writeFile(...args);
    },
  };
});

import {
  findTelegramTopicBindingByThread,
  saveTelegramTopicBinding,
  updateTelegramTopicBinding,
} from "../../../src/app/services/telegram-topic-store.js";

describe("Telegram Topic store Core transaction boundary", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "topic-store-core-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    mocked.failBindingWrite = false;
    mocked.registerCoreTopicBinding.mockReset().mockResolvedValue(undefined);
    mocked.rotateCoreTopicBinding.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    mocked.failBindingWrite = false;
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("persists Core identity before exposing a new Telegram binding", async () => {
    const binding = {
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: path.join(home, "workspace"),
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
      title: "Chat #01",
    };

    await saveTelegramTopicBinding(binding);

    expect(mocked.registerCoreTopicBinding).toHaveBeenCalledWith(binding);
    await expect(findTelegramTopicBindingByThread(100, 42)).resolves.toMatchObject({
      sessionId: "session-1",
      directory: binding.directory,
    });
  });

  it("rolls Core identity back when Telegram metadata persistence fails after rotation", async () => {
    const binding = {
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory: path.join(home, "workspace"),
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
      title: "Chat #01",
    };
    await saveTelegramTopicBinding(binding);
    mocked.rotateCoreTopicBinding.mockClear();
    mocked.failBindingWrite = true;

    await expect(
      updateTelegramTopicBinding(100, 42, { sessionId: "session-2" }),
    ).rejects.toThrow("simulated binding metadata write failure");

    expect(mocked.rotateCoreTopicBinding).toHaveBeenCalledTimes(2);
    expect(mocked.rotateCoreTopicBinding.mock.calls[0]).toEqual([
      expect.objectContaining({ sessionId: "session-1", directory: binding.directory }),
      { sessionId: "session-2", directory: binding.directory },
    ]);
    expect(mocked.rotateCoreTopicBinding.mock.calls[1]).toEqual([
      expect.objectContaining({ sessionId: "session-2", directory: binding.directory }),
      { sessionId: "session-1", directory: binding.directory },
    ]);
    mocked.failBindingWrite = false;
    await expect(findTelegramTopicBindingByThread(100, 42)).resolves.toMatchObject({
      sessionId: "session-1",
    });
  });
});

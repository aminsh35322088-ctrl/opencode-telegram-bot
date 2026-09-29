import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  promptAsync: vi.fn(),
  abort: vi.fn(),
  resolveCatalogModel: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: {
      token: "123456:test-token",
    },
  },
}));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      promptAsync: mocked.promptAsync,
      abort: mocked.abort,
    },
  },
}));

vi.mock("../../src/app/services/model-selection-service.js", () => ({
  resolveCatalogModel: mocked.resolveCatalogModel,
}));

import {
  beginCoreRunForSession,
  dispatchCorePrompt,
  finishCoreRunForSession,
  initializeNativeCore,
  runCoreIdleMaintenance,
  shutdownNativeCore,
} from "../../src/core/native-core-service.js";
import { runInTopicRuntimeContext } from "../../src/app/services/topic-runtime-context.js";

describe("native Core adapter", () => {
  let home = "";
  let directory = "";

  beforeEach(async () => {
    await shutdownNativeCore();
    home = await mkdtemp(path.join(os.tmpdir(), "native-core-adapter-"));
    directory = path.join(home, "workspace");
    await mkdir(directory, { recursive: true });
    process.env.OPENCODE_TELEGRAM_HOME = home;
    mocked.promptAsync.mockReset().mockResolvedValue({ data: true });
    mocked.abort.mockReset().mockResolvedValue({ data: true });
    mocked.resolveCatalogModel.mockReset().mockResolvedValue(null);
  });

  afterEach(async () => {
    await shutdownNativeCore();
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("admits and dispatches only through the exact bound Topic identity", async () => {
    await initializeNativeCore({} as never, [{
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory,
    }]);

    const run = await runInTopicRuntimeContext(
      { chatId: 100, threadId: 42, sessionId: "session-1", directory },
      () => beginCoreRunForSession("session-1", directory, "interactive_prompt", true),
    );

    const result = await dispatchCorePrompt(run, {
      sessionID: "session-1",
      directory,
      parts: [{ type: "text", text: "hello" }],
    });

    expect(result).toEqual({ data: true });
    expect(mocked.promptAsync).toHaveBeenCalledTimes(1);
    expect(mocked.promptAsync.mock.calls[0]?.[0]).toMatchObject({
      sessionID: "session-1",
      directory,
    });
    expect(finishCoreRunForSession("session-1")).toBe(true);
  });

  it("rejects the same session when the Topic directory identity is wrong", async () => {
    await initializeNativeCore({} as never, [{
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory,
    }]);

    await expect(
      runInTopicRuntimeContext(
        {
          chatId: 100,
          threadId: 42,
          sessionId: "session-1",
          directory: path.join(home, "other-workspace"),
        },
        () => beginCoreRunForSession("session-1", directory, "interactive_prompt", true),
      ),
    ).rejects.toThrow(/exact bound AI Topic/i);

    expect(mocked.promptAsync).not.toHaveBeenCalled();
  });

  it("refuses idle maintenance while a Core run is active and allows it after completion", async () => {
    await initializeNativeCore({} as never, [{
      chatId: 100,
      threadId: 42,
      sessionId: "session-1",
      directory,
    }]);

    const run = await runInTopicRuntimeContext(
      { chatId: 100, threadId: 42, sessionId: "session-1", directory },
      () => beginCoreRunForSession("session-1", directory, "interactive_prompt", true),
    );

    const maintenanceTask = vi.fn().mockResolvedValue(true);
    await expect(runCoreIdleMaintenance("test", maintenanceTask)).resolves.toBe(false);
    expect(maintenanceTask).not.toHaveBeenCalled();

    expect(finishCoreRunForSession("session-1")).toBe(true);
    await expect(runCoreIdleMaintenance("test", maintenanceTask)).resolves.toBe(true);
    expect(maintenanceTask).toHaveBeenCalledTimes(1);
  });

  it("keeps General/control-only model admission fail-closed", async () => {
    await initializeNativeCore({} as never, [{
      chatId: 100,
      threadId: 1,
      sessionId: "general-session",
      directory,
    }]);

    await expect(
      runInTopicRuntimeContext(
        { chatId: 100, threadId: 1, sessionId: "general-session", directory },
        () => beginCoreRunForSession("general-session", directory, "interactive_prompt", true),
      ),
    ).rejects.toThrow(/admission rejected/i);

    expect(mocked.promptAsync).not.toHaveBeenCalled();
  });
});

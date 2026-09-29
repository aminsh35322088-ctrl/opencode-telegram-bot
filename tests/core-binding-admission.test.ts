import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Api } from "grammy";
import {
  beginCoreRunForSession,
  initializeNativeCore,
  runCoreSessionTask,
  shutdownNativeCore,
} from "../src/core/native-core-service.js";
import { runInTopicRuntimeContext } from "../src/app/services/topic-runtime-context.js";

test("ambiguous session ownership fails closed before starting a Core run", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-admission-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousUser = process.env.TELEGRAM_ALLOWED_USER_ID;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = "12345:test-token";
  process.env.TELEGRAM_ALLOWED_USER_ID = "1";
  try {
    await initializeNativeCore({} as Api, [
      { chatId: 1, threadId: 2, sessionId: "shared", directory: "/workspace" },
      { chatId: 1, threadId: 3, sessionId: "shared", directory: "/workspace" },
    ]);
    await runInTopicRuntimeContext(
      { chatId: 1, threadId: 2, sessionId: "shared", directory: "/workspace" },
      async () => assert.rejects(
        beginCoreRunForSession("shared", "/workspace"),
        /Expected exactly one Core Topic binding.*found 2/,
      ),
    );
  } finally {
    await shutdownNativeCore();
    if (previousHome === undefined) delete process.env.OPENCODE_TELEGRAM_HOME;
    else process.env.OPENCODE_TELEGRAM_HOME = previousHome;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousUser === undefined) delete process.env.TELEGRAM_ALLOWED_USER_ID;
    else process.env.TELEGRAM_ALLOWED_USER_ID = previousUser;
    await rm(home, { recursive: true, force: true });
  }
});

test("Core-owned session operation runs only in its bound Topic and releases its lease", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-operation-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousUser = process.env.TELEGRAM_ALLOWED_USER_ID;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = "12345:test-token";
  process.env.TELEGRAM_ALLOWED_USER_ID = "1";
  try {
    await initializeNativeCore({} as Api, [
      { chatId: 1, threadId: 2, sessionId: "owned", directory: "/workspace" },
    ]);
    await assert.rejects(
      runCoreSessionTask("owned", "/workspace", "compact", async () => true),
      /exact bound AI Topic/,
    );
    await runInTopicRuntimeContext(
      { chatId: 1, threadId: 2, sessionId: "owned", directory: "/workspace" },
      async () => {
        assert.equal(await runCoreSessionTask("owned", "/workspace", "compact", async ({ signal }) => !signal.aborted), true);
        await assert.rejects(runCoreSessionTask("owned", "/workspace", "compact", async () => { throw new Error("failed"); }), /failed/);
        assert.equal(await runCoreSessionTask("owned", "/workspace", "compact", async () => 42), 42);
      },
    );
  } finally {
    await shutdownNativeCore();
    if (previousHome === undefined) delete process.env.OPENCODE_TELEGRAM_HOME;
    else process.env.OPENCODE_TELEGRAM_HOME = previousHome;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousUser === undefined) delete process.env.TELEGRAM_ALLOWED_USER_ID;
    else process.env.TELEGRAM_ALLOWED_USER_ID = previousUser;
    await rm(home, { recursive: true, force: true });
  }
});

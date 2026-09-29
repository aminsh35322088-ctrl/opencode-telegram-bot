import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Api, Context } from "grammy";
import { runInTopicRuntimeContext } from "../src/app/services/topic-runtime-context.js";
import { saveTelegramTopicBinding } from "../src/app/services/telegram-topic-store.js";
import { initializeNativeCore, rotateCoreTopicBinding, shutdownNativeCore } from "../src/core/native-core-service.js";
import { resolveReplyKeyboardContext } from "../src/bot/interaction-classifier.js";
import {
  getCurrentSession,
  getEffectiveCurrentSession,
} from "../src/app/services/session-service.js";
import {
  __resetSettingsForTests,
  clearSession,
  flushSettings,
  setCurrentSession,
} from "../src/app/stores/settings-store.js";

test("an unbound Topic cannot inherit the global session", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-topic-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  __resetSettingsForTests();
  try {
    setCurrentSession({ id: "global", title: "Global", directory: "/global" });
    assert.equal(getCurrentSession()?.id, "global");
    await runInTopicRuntimeContext({ chatId: 1, threadId: 2 }, async () => {
      assert.equal(getCurrentSession(), null);
      assert.equal(await getEffectiveCurrentSession(), null);
    });
  } finally {
    clearSession();
    await flushSettings();
    __resetSettingsForTests();
    if (previousHome === undefined) delete process.env.OPENCODE_TELEGRAM_HOME;
    else process.env.OPENCODE_TELEGRAM_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("a rotated Core Topic rejects stale metadata for session and keyboard routing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-stale-topic-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousUser = process.env.TELEGRAM_ALLOWED_USER_ID;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = "12345:test-token";
  process.env.TELEGRAM_ALLOWED_USER_ID = "1";
  try {
    await initializeNativeCore({} as Api, []);
    await saveTelegramTopicBinding({
      chatId: 1, threadId: 2, sessionId: "old", directory: "/workspace",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const ctx = { chat: { id: 1 }, message: { message_thread_id: 2 } } as Context;
    await runInTopicRuntimeContext({ chatId: 1, threadId: 2, sessionId: "old", directory: "/workspace" }, async () => {
      assert.equal((await getEffectiveCurrentSession())?.id, "old");
      assert.equal((await resolveReplyKeyboardContext(ctx)).scope, "ai-topic");
      await rotateCoreTopicBinding(
        { chatId: 1, threadId: 2, sessionId: "old", directory: "/workspace" },
        { sessionId: "new", directory: "/workspace" },
      );
      assert.equal(await getEffectiveCurrentSession(), null);
      assert.equal((await resolveReplyKeyboardContext(ctx)).scope, "main");
    });
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

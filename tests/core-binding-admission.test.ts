import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Api } from "grammy";
import {
  beginCoreRunForSession,
  finishCoreRunForSession,
  initializeNativeCore,
  runCoreSessionTask,
  resolveCoreSessionRoute,
  isCurrentCoreSessionRoute,
  resolveCoreEventRoute,
  resolveCoreTopicBinding,
  rotateCoreTopicBinding,
  shutdownNativeCore,
} from "../src/core/native-core-service.js";
import { runInTopicRuntimeContext } from "../src/app/services/topic-runtime-context.js";
import { createCoreSessionApi } from "../src/bot/services/core-session-api.js";
import { resolveTailnetSshScope } from "../src/app/services/ssh-service.js";

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

test("Core routes session output only to its current exact Topic binding", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-output-route-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousUser = process.env.TELEGRAM_ALLOWED_USER_ID;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = "12345:test-token";
  process.env.TELEGRAM_ALLOWED_USER_ID = "1";
  try {
    await initializeNativeCore({} as Api, [
      { chatId: 1, threadId: 2, sessionId: "first", directory: "/workspace/a" },
      { chatId: 1, threadId: 3, sessionId: "second", directory: "/workspace/b" },
    ]);
    const route = resolveCoreSessionRoute("first", "/workspace/a");
    assert.deepEqual({ chatId: route.chatId, threadId: route.threadId }, { chatId: 1, threadId: 2 });
    assert.equal(resolveCoreTopicBinding(1, 2)?.sessionId, "first");
    assert.equal(await resolveTailnetSshScope("first"), "topic:1:2");
    assert.equal(resolveCoreTopicBinding(1, 1), null);
    assert.equal(isCurrentCoreSessionRoute(route), true);
    assert.throws(() => resolveCoreSessionRoute("first", "/workspace/b"), /exactly one Core Topic binding/);
    await rotateCoreTopicBinding(
      { chatId: 1, threadId: 2, sessionId: "first", directory: "/workspace/a" },
      { sessionId: "replacement", directory: "/workspace/a" },
    );
    assert.equal(isCurrentCoreSessionRoute(route), false);
    assert.equal(resolveCoreTopicBinding(1, 2)?.sessionId, "replacement");
    assert.equal(await resolveTailnetSshScope("first"), "session:first");
    assert.throws(() => resolveCoreSessionRoute("first"), /exactly one Core Topic binding/);
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

test("a late Telegram send cannot escape a rotated Core binding", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-send-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousUser = process.env.TELEGRAM_ALLOWED_USER_ID;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = "12345:test-token";
  process.env.TELEGRAM_ALLOWED_USER_ID = "1";
  const sent: Array<{ chatId: number; threadId?: number }> = [];
  const rich: Array<{ payload: unknown; threadId?: number }> = [];
  const api = {
    sendMessage: async (chatId: number, _text: string, options?: { message_thread_id?: number }) => {
      sent.push({ chatId, threadId: options?.message_thread_id });
    },
    sendRichMessage: async (_chatId: number, payload: unknown, options?: { message_thread_id?: number }) => {
      rich.push({ payload, threadId: options?.message_thread_id });
    },
  } as unknown as Api;
  try {
    await initializeNativeCore(api, [
      { chatId: 1, threadId: 2, sessionId: "first", directory: "/workspace" },
    ]);
    const scoped = createCoreSessionApi(api, "first");
    await scoped.sendMessage(1, "hello");
    assert.deepEqual(sent, [{ chatId: 1, threadId: 2 }]);
    const payload = { blocks: [{ type: "paragraph", text: "hello" }] };
    await scoped.sendRichMessage(1, payload as never);
    assert.deepEqual(rich, [{ payload, threadId: 2 }]);
    assert.deepEqual(payload, { blocks: [{ type: "paragraph", text: "hello" }] });
    await rotateCoreTopicBinding(
      { chatId: 1, threadId: 2, sessionId: "first", directory: "/workspace" },
      { sessionId: "new", directory: "/workspace" },
    );
    assert.throws(() => scoped.sendMessage(1, "late"), /Core Topic binding changed/);
    assert.equal(sent.length, 1);
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

test("event routing refuses ambiguous directories and old sessions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-event-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousUser = process.env.TELEGRAM_ALLOWED_USER_ID;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = "12345:test-token";
  process.env.TELEGRAM_ALLOWED_USER_ID = "1";
  try {
    await initializeNativeCore({} as Api, [
      { chatId: 1, threadId: 2, sessionId: "first", directory: "/workspace" },
      { chatId: 1, threadId: 3, sessionId: "second", directory: "/workspace" },
    ]);
    assert.equal(resolveCoreEventRoute("first", "/workspace")?.threadId, 2);
    assert.equal(resolveCoreEventRoute("second", "/foreign"), null);
    assert.equal(resolveCoreEventRoute(null, "/workspace"), null);
    await rotateCoreTopicBinding(
      { chatId: 1, threadId: 2, sessionId: "first", directory: "/workspace" },
      { sessionId: "replacement", directory: "/workspace" },
    );
    assert.equal(resolveCoreEventRoute("first", "/workspace"), null);
    assert.equal(resolveCoreEventRoute("replacement", "/workspace")?.threadId, 2);
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

test("a known session event cannot inherit another Topic's directory while it runs", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-foreign-event-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousUser = process.env.TELEGRAM_ALLOWED_USER_ID;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = "12345:test-token";
  process.env.TELEGRAM_ALLOWED_USER_ID = "1";
  try {
    await initializeNativeCore({} as Api, [
      { chatId: 1, threadId: 2, sessionId: "first", directory: "/workspace/a" },
      { chatId: 1, threadId: 3, sessionId: "second", directory: "/workspace/b" },
    ]);
    await runInTopicRuntimeContext(
      { chatId: 1, threadId: 3, sessionId: "second", directory: "/workspace/b" },
      async () => {
        await beginCoreRunForSession("second", "/workspace/b");
        try {
          assert.equal(resolveCoreEventRoute("first", "/workspace/b"), null);
        } finally {
          finishCoreRunForSession("second");
        }
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

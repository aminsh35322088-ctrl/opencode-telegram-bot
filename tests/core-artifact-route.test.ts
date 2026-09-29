import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Api } from "grammy";
import type { Event } from "@opencode-ai/sdk/v2";
import { agentArtifactDeliveryService } from "../src/bot/services/agent-artifact-delivery-service.js";
import { initializeNativeCore, rotateCoreTopicBinding, shutdownNativeCore } from "../src/core/native-core-service.js";
import { runInTopicRuntimeContext } from "../src/app/services/topic-runtime-context.js";

test("generated artifact delivery uses the bound Core Topic and the shared bot API", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-artifact-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousUser = process.env.TELEGRAM_ALLOWED_USER_ID;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = "12345:test-token";
  process.env.TELEGRAM_ALLOWED_USER_ID = "1";
  const sent: Array<{ chatId: number; threadId?: number }> = [];
  const api = { sendDocument: async (chatId: number, _file: unknown, options?: { message_thread_id?: number }) => {
    sent.push({ chatId, threadId: options?.message_thread_id });
  } } as unknown as Api;
  try {
    await initializeNativeCore(api, [{ chatId: 1, threadId: 2, sessionId: "owned", directory: home }]);
    agentArtifactDeliveryService.setApi(api);
    const file = path.join(home, "result.bin");
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    await runInTopicRuntimeContext({ chatId: 1, threadId: 2, sessionId: "owned", directory: home }, async () => {
      agentArtifactDeliveryService.processEvent({ type: "file.edited", properties: { file } } as Event);
    });
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.deepEqual(sent, [{ chatId: 1, threadId: 2 }]);
    const lateFile = path.join(home, "late-result.bin");
    await writeFile(lateFile, Buffer.from([0, 1, 2, 3]));
    await runInTopicRuntimeContext({ chatId: 1, threadId: 2, sessionId: "owned", directory: home }, async () => {
      agentArtifactDeliveryService.processEvent({ type: "file.edited", properties: { file: lateFile } } as Event);
    });
    await rotateCoreTopicBinding(
      { chatId: 1, threadId: 2, sessionId: "owned", directory: home },
      { sessionId: "new", directory: home },
    );
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.equal(sent.length, 1);
  } finally {
    agentArtifactDeliveryService.clear();
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

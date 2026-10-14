import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantRunState } from "../src/app/managers/assistant-run-state-manager.js";
import { typingIndicatorManager } from "../src/bot/services/typing-indicator-manager.js";

test("typing heartbeat is scoped to the active Telegram forum Topic", async () => {
  assistantRunState.__resetForTests();
  assistantRunState.startRun("session", { startedAt: Date.now() }, "run");
  const calls: unknown[][] = [];
  const api = {
    sendChatAction: async (...args: unknown[]) => {
      calls.push(args);
      return true;
    },
  } as any;
  typingIndicatorManager.start("session", api, -100123, 77);
  await new Promise((resolve) => setTimeout(resolve, 0));
  typingIndicatorManager.stop("session", "test");
  assistantRunState.__resetForTests();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [-100123, "typing", { message_thread_id: 77 }]);
});

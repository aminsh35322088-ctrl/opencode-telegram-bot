import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { assistantRunState } from "../src/app/managers/assistant-run-state-manager.js";
import { foregroundSessionState } from "../src/app/managers/foreground-session-state-manager.js";
import { cancelCurrentRun } from "../src/app/services/current-run-cancellation-service.js";
import { opencodeClient } from "../src/opencode/client.js";

const sessionApi = (opencodeClient as unknown as { session: Record<string, unknown> }).session as any;
const originalAbort = sessionApi.abort;
const originalStatus = sessionApi.status;

afterEach(() => {
  sessionApi.abort = originalAbort;
  sessionApi.status = originalStatus;
  assistantRunState.__resetForTests();
  foregroundSessionState.__resetForTests();
});

test("internal cancellation confirms exact session and releases local run state without Telegram UI", async () => {
  const calls: unknown[] = [];
  sessionApi.abort = async (...args: unknown[]) => {
    calls.push(args);
    return { data: true, error: undefined };
  };
  sessionApi.status = async () => ({ data: {}, error: undefined });
  assistantRunState.startRun("ses_exact", { startedAt: Date.now() });
  foregroundSessionState.markBusy("ses_exact", "/workspace/exact");

  const result = await cancelCurrentRun({
    sessionId: "ses_exact",
    directory: "/workspace/exact",
    reason: "native_stop_test",
    timeoutMs: 500,
  });

  assert.equal(result, "confirmed");
  assert.equal(assistantRunState.hasActiveRun("ses_exact"), false);
  assert.equal(foregroundSessionState.isSessionBusy("ses_exact"), false);
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as unknown[])[0], { sessionID: "ses_exact", directory: "/workspace/exact" });
});

test("unconfirmed cancellation preserves local busy ownership", async () => {
  sessionApi.abort = async () => ({ data: undefined, error: new Error("transport uncertain") });
  sessionApi.status = async () => ({ data: { ses_exact: { type: "busy" } }, error: undefined });
  assistantRunState.startRun("ses_exact", { startedAt: Date.now() });
  foregroundSessionState.markBusy("ses_exact", "/workspace/exact");

  const result = await cancelCurrentRun({
    sessionId: "ses_exact",
    directory: "/workspace/exact",
    reason: "native_stop_uncertain_test",
    timeoutMs: 500,
  });

  assert.equal(result, "unconfirmed");
  assert.equal(assistantRunState.hasActiveRun("ses_exact"), true);
  assert.equal(foregroundSessionState.isSessionBusy("ses_exact"), true);
});

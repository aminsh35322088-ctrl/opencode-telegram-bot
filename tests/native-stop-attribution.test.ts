import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { assistantRunState } from "../src/app/managers/assistant-run-state-manager.js";
import { foregroundSessionState } from "../src/app/managers/foreground-session-state-manager.js";
import { cancelCurrentRun } from "../src/app/services/current-run-cancellation-service.js";
import { registerGenerationDraft } from "../src/bot/messages/telegram-text.js";
import { opencodeClient } from "../src/opencode/client.js";

const sessionApi = (opencodeClient as unknown as { session: Record<string, unknown> }).session as any;
const originalAbort = sessionApi.abort;
const originalStatus = sessionApi.status;

const CHAT_ID = 777000111;
const SESSION_ID = "ses_owner";
const DIRECTORY = "/data/workspace/owner";

let nextDraftId = 1_500_000_000;

afterEach(() => {
  sessionApi.abort = originalAbort;
  sessionApi.status = originalStatus;
  assistantRunState.__resetForTests();
  foregroundSessionState.__resetForTests();
});

function stubAbort(): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  sessionApi.abort = async (...args: unknown[]) => {
    calls.push(args);
    return { data: true, error: undefined };
  };
  sessionApi.status = async () => ({ data: {}, error: undefined });
  return { calls };
}

function freshDraftId(): number {
  nextDraftId += 1;
  return nextDraftId;
}

test("native Stop cancels the exact run that produced the stopped draft", async () => {
  const { calls } = stubAbort();
  const draftId = freshDraftId();
  assistantRunState.startRun(SESSION_ID, { startedAt: Date.now() - 30_000 });
  foregroundSessionState.markBusy(SESSION_ID, DIRECTORY);
  registerGenerationDraft(CHAT_ID, draftId);

  const result = await cancelCurrentRun({
    sessionId: SESSION_ID,
    directory: DIRECTORY,
    reason: "telegram_native_stop",
    timeoutMs: 500,
    stopAttribution: { chatId: CHAT_ID, draftId },
  });

  assert.equal(result, "confirmed");
  assert.equal(calls.length, 1, "the owning run must be aborted exactly once");
});

test("native Stop on a draft that predates the active run must not abort the newer run", async () => {
  const { calls } = stubAbort();
  const staleDraftId = freshDraftId();
  // The draft belongs to an earlier run that already ended.
  registerGenerationDraft(CHAT_ID, staleDraftId, Date.now() - 60_000);
  // A newer run is active for the same session.
  assistantRunState.startRun(SESSION_ID, { startedAt: Date.now() - 1_000 });
  foregroundSessionState.markBusy(SESSION_ID, DIRECTORY);

  const result = await cancelCurrentRun({
    sessionId: SESSION_ID,
    directory: DIRECTORY,
    reason: "telegram_native_stop",
    timeoutMs: 500,
    stopAttribution: { chatId: CHAT_ID, draftId: staleDraftId },
  });

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0, "a newer run must never be aborted by an older draft");
  assert.equal(assistantRunState.hasActiveRun(SESSION_ID), true, "the newer run stays active");
});

test("native Stop with a draft the Bot never issued is refused", async () => {
  const { calls } = stubAbort();
  assistantRunState.startRun(SESSION_ID, { startedAt: Date.now() - 30_000 });
  foregroundSessionState.markBusy(SESSION_ID, DIRECTORY);

  const result = await cancelCurrentRun({
    sessionId: SESSION_ID,
    directory: DIRECTORY,
    reason: "telegram_native_stop",
    timeoutMs: 500,
    stopAttribution: { chatId: CHAT_ID, draftId: freshDraftId() },
  });

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0, "an unattributable Stop must not abort anything");
  assert.equal(assistantRunState.hasActiveRun(SESSION_ID), true);
});

test("native Stop with no active run is refused instead of cancelling local interaction state", async () => {
  const { calls } = stubAbort();
  const draftId = freshDraftId();
  registerGenerationDraft(CHAT_ID, draftId);

  const result = await cancelCurrentRun({
    sessionId: SESSION_ID,
    directory: DIRECTORY,
    reason: "telegram_native_stop",
    timeoutMs: 500,
    stopAttribution: { chatId: CHAT_ID, draftId },
  });

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0);
});

test("internal cancellation keeps working without Stop attribution", async () => {
  const { calls } = stubAbort();
  assistantRunState.startRun(SESSION_ID, { startedAt: Date.now() - 30_000 });
  foregroundSessionState.markBusy(SESSION_ID, DIRECTORY);

  const result = await cancelCurrentRun({
    sessionId: SESSION_ID,
    directory: DIRECTORY,
    reason: "user",
    timeoutMs: 500,
  });

  assert.equal(result, "confirmed");
  assert.equal(calls.length, 1);
});

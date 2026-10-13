import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { assistantRunState } from "../src/app/managers/assistant-run-state-manager.js";
import { foregroundSessionState } from "../src/app/managers/foreground-session-state-manager.js";
import { cancelCurrentRun } from "../src/app/services/current-run-cancellation-service.js";
import { runInTopicRuntimeContext } from "../src/app/services/topic-runtime-context.js";
import {
  registerGenerationDraft,
  type GenerationDraftOwner,
} from "../src/bot/messages/telegram-text.js";
import { opencodeClient } from "../src/opencode/client.js";

const sessionApi = (opencodeClient as unknown as { session: Record<string, unknown> }).session as any;
const originalAbort = sessionApi.abort;
const originalStatus = sessionApi.status;

const CHAT_ID = 777000111;
const THREAD_ID = 4242;
const OTHER_THREAD_ID = 9876;
const SESSION_ID = "ses_owner";
const OTHER_SESSION_ID = "ses_other";
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

function startRun(startedAt = Date.now() - 30_000): { runId: string; generation: number } {
  assistantRunState.startRun(SESSION_ID, { startedAt });
  foregroundSessionState.markBusy(SESSION_ID, DIRECTORY);
  const run = assistantRunState.getRun(SESSION_ID);
  assert.ok(run, "run must be tracked after startRun");
  return { runId: run.runId, generation: run.generation };
}

function ownerOf(
  run: { runId: string; generation: number },
  overrides: Partial<GenerationDraftOwner> = {},
): GenerationDraftOwner {
  return {
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    sessionId: SESSION_ID,
    runId: run.runId,
    generation: run.generation,
    ...overrides,
  };
}

function stopOptions(draftId: number) {
  return {
    sessionId: SESSION_ID,
    directory: DIRECTORY,
    reason: "telegram_native_stop",
    timeoutMs: 500,
    stopAttribution: { chatId: CHAT_ID, draftId },
  };
}

test("Stop cancels the run whose exact Topic/session/run/generation identity issued the draft", async () => {
  const { calls } = stubAbort();
  const run = startRun();
  const draftId = freshDraftId();
  registerGenerationDraft(CHAT_ID, draftId, Date.now(), ownerOf(run));

  const result = await cancelCurrentRun(stopOptions(draftId));

  assert.equal(result, "confirmed");
  assert.equal(calls.length, 1, "the owning run must be aborted exactly once");
});

test("Stop is refused when only timing matches but the run identity differs", async () => {
  const { calls } = stubAbort();
  const run = startRun();
  const draftId = freshDraftId();
  // createdAt is AFTER the active run started, so a purely time-based check
  // would have allowed this Stop. Identity must still refuse it.
  registerGenerationDraft(
    CHAT_ID,
    draftId,
    Date.now(),
    ownerOf(run, { runId: `${run.runId}:previous` }),
  );

  const result = await cancelCurrentRun(stopOptions(draftId));

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0, "a draft from another run must not abort this run");
  assert.equal(assistantRunState.hasActiveRun(SESSION_ID), true);
});

test("Stop with a draft from an earlier run never cancels the newer run", async () => {
  const { calls } = stubAbort();
  const oldRun = startRun();
  const oldDraftId = freshDraftId();
  registerGenerationDraft(CHAT_ID, oldDraftId, Date.now(), ownerOf(oldRun));

  // Race: the first run ends and a newer run starts before the user reaches Stop.
  assistantRunState.clearRun(SESSION_ID, "run completed");
  const newRun = startRun(Date.now() - 100);

  const result = await cancelCurrentRun(stopOptions(oldDraftId));

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0, "the newer run must not be aborted by an old draft");
  assert.equal(assistantRunState.getRun(SESSION_ID)?.runId, newRun.runId, "newer run stays active");
});

test("Stop is refused when the draft belongs to a different generation", async () => {
  const { calls } = stubAbort();
  const run = startRun();
  const draftId = freshDraftId();
  registerGenerationDraft(
    CHAT_ID,
    draftId,
    Date.now(),
    ownerOf(run, { generation: run.generation + 1 }),
  );

  const result = await cancelCurrentRun(stopOptions(draftId));

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0);
});

test("Stop is refused after a restart until a new run issues a new draft", async () => {
  const { calls } = stubAbort();
  const beforeRestart = startRun();
  const preRestartDraftId = freshDraftId();
  registerGenerationDraft(CHAT_ID, preRestartDraftId, Date.now(), ownerOf(beforeRestart));

  // Restart clears run state; the new run gets a new identity.
  assistantRunState.__resetForTests();
  const afterRestart = startRun(Date.now() - 50);

  const stale = await cancelCurrentRun(stopOptions(preRestartDraftId));
  assert.equal(stale, "stale-draft");
  assert.equal(calls.length, 0, "a pre-restart draft must not abort a post-restart run");
  assert.equal(assistantRunState.getRun(SESSION_ID)?.runId, afterRestart.runId);

  // A draft issued by the new run does cancel it.
  const postRestartDraftId = freshDraftId();
  registerGenerationDraft(CHAT_ID, postRestartDraftId, Date.now(), ownerOf(afterRestart));
  const result = await cancelCurrentRun(stopOptions(postRestartDraftId));
  assert.equal(result, "confirmed");
  assert.equal(calls.length, 1);
});

test("Stop is refused when the draft belongs to another Topic", async () => {
  const { calls } = stubAbort();
  const run = startRun();
  const draftId = freshDraftId();
  registerGenerationDraft(CHAT_ID, draftId, Date.now(), ownerOf(run, { threadId: OTHER_THREAD_ID }));

  const result = await runInTopicRuntimeContext(
    { chatId: CHAT_ID, threadId: THREAD_ID, sessionId: SESSION_ID, directory: DIRECTORY },
    () => cancelCurrentRun(stopOptions(draftId)),
  );

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0, "a Stop in Topic A must not cancel another Topic's run");
  assert.equal(assistantRunState.hasActiveRun(SESSION_ID), true);
});

test("Stop is refused when the draft belongs to another session", async () => {
  const { calls } = stubAbort();
  const run = startRun();
  const draftId = freshDraftId();
  registerGenerationDraft(
    CHAT_ID,
    draftId,
    Date.now(),
    ownerOf(run, { sessionId: OTHER_SESSION_ID }),
  );

  const result = await cancelCurrentRun(stopOptions(draftId));

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0);
});

test("Stop with a draft the Bot never issued is refused", async () => {
  const { calls } = stubAbort();
  startRun();

  const result = await cancelCurrentRun(stopOptions(freshDraftId()));

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0);
});

test("Stop is refused when the draft carries no owning run identity", async () => {
  const { calls } = stubAbort();
  startRun();
  const draftId = freshDraftId();
  // Registered without an owner and outside any Topic context: unattributable.
  registerGenerationDraft(CHAT_ID, draftId);

  const result = await cancelCurrentRun(stopOptions(draftId));

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0);
});

test("Stop is refused when no run is active, instead of clearing local state", async () => {
  const { calls } = stubAbort();
  const run = startRun();
  const draftId = freshDraftId();
  registerGenerationDraft(CHAT_ID, draftId, Date.now(), ownerOf(run));
  assistantRunState.clearRun(SESSION_ID, "run completed");
  foregroundSessionState.markIdle(SESSION_ID);

  const result = await cancelCurrentRun(stopOptions(draftId));

  assert.equal(result, "stale-draft");
  assert.equal(calls.length, 0);
});

test("internal cancellation keeps working without Stop attribution", async () => {
  const { calls } = stubAbort();
  startRun();

  const result = await cancelCurrentRun({
    sessionId: SESSION_ID,
    directory: DIRECTORY,
    reason: "user",
    timeoutMs: 500,
  });

  assert.equal(result, "confirmed");
  assert.equal(calls.length, 1);
});

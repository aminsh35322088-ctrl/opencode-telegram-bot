import assert from "node:assert/strict";
import { test } from "node:test";

// The soak harness drives the real Bot through raw Telegram updates. Two of its
// assumptions were wrong and only an end-to-end cycle run could see it: thread
// messages that are not marked `is_topic_message` are silently dropped by the
// Bot's Topic extraction (Delete Chat never answered), and a Bot streaming in
// `edit` mode never issues a draft, so Telegram Stop arrives with an id the Bot
// cannot attribute (`unknown-draft`). These cases pin the harness contract.
async function loadScript<T = Record<string, unknown>>(relative: string): Promise<T> {
  return (await import(new URL(`../${relative}`, import.meta.url).href)) as T;
}

test("a thread-bound message update marks is_topic_message so the Bot resolves Topic scope", async () => {
  const { createUpdateBuilders } = await loadScript<{
    createUpdateBuilders: (options: { userId: number }) => {
      messageUpdate: (
        text: string,
        options?: { chatId?: number; fromId?: number; threadId?: number },
      ) => { message: Record<string, unknown> };
    };
  }>("scripts/soak/updates.mjs");

  const builders = createUpdateBuilders({ userId: 987654321 });
  const inTopic = builders.messageUpdate("🗑️ Delete Chat", { threadId: 10000 });

  assert.equal(inTopic.message.message_thread_id, 10000);
  assert.equal(
    inTopic.message.is_topic_message,
    true,
    "real Telegram sets is_topic_message on forum-topic messages; without it the Bot's getTopicFromMessage() returns null and consumes the control without answering",
  );

  const direct = builders.messageUpdate("/start");
  assert.equal(direct.message.is_topic_message, undefined);
});

test("a thread-bound callback update marks is_topic_message on its embedded message", async () => {
  const { createUpdateBuilders } = await loadScript<{
    createUpdateBuilders: (options: { userId: number }) => {
      callbackUpdate: (
        data: string,
        messageId: number | null,
        threadId?: number,
      ) => { callback_query: { message?: Record<string, unknown> } };
    };
  }>("scripts/soak/updates.mjs");

  const builders = createUpdateBuilders({ userId: 987654321 });
  const inTopic = builders.callbackUpdate("telegram-topic:delete:confirm", 55, 10000);

  assert.equal(inTopic.callback_query.message?.message_thread_id, 10000);
  assert.equal(
    inTopic.callback_query.message?.is_topic_message,
    true,
    "the Delete confirmation callback is resolved through the same Topic extraction as the button press",
  );
});

test("seeded soak settings select draft streaming so Telegram Stop has a draft to attribute", async () => {
  const { settingsPatch } = await loadScript<{
    settingsPatch: (options: { providerId: string; modelId: string; modelName: string }) => Record<string, unknown>;
  }>("scripts/soak/seed-state.mjs");

  const patch = settingsPatch({ providerId: "soak", modelId: "soak-model", modelName: "Soak Stub Model" });

  assert.equal(
    patch.responseStreamingMode,
    "draft",
    "default streaming mode is `edit`, which never issues a draft; Telegram's stopped_message_generation then carries an id the Bot never registered and refuses the Stop as unknown-draft",
  );
  const topicDefaults = patch.topicDefaults as Record<string, unknown> | undefined;
  assert.equal(
    topicDefaults?.responseStreamingMode,
    "draft",
    "a Topic created by New Chat takes its settings from topicDefaults, so the global value alone is not enough",
  );
});

test("growth is observed as a new draft or a new message, never by a stale baseline", async () => {
  const { snapshot, growthObserved } = await loadScript<{
    snapshot: (state: Record<string, unknown>) => {
      messages: number;
      drafts: number;
      threads: Array<number | string>;
    };
    growthObserved: (state: Record<string, unknown>, base: { messages: number; drafts: number }) => boolean;
  }>("scripts/soak/signals.mjs");

  const base = snapshot({ messages: { 1: "welcome" }, drafts: [] });
  assert.deepEqual(base, { messages: 1, drafts: 0, threads: [] });

  assert.equal(
    growthObserved({ messages: { 1: "welcome" }, drafts: [{ draft_id: 7 }] }, base),
    true,
    "draft mode announces the run as a draft, before any message exists",
  );
  assert.equal(growthObserved({ messages: { 1: "welcome", 2: "reply" }, drafts: [] }, base), true);
  assert.equal(
    growthObserved({ messages: { 1: "welcome" }, drafts: [] }, base),
    false,
    "a baseline that already counts a previous cycle's output must not report growth again",
  );
});

test("a Stop is confirmed only by the Bot's confirmed attribution of that exact draft", async () => {
  const { snapshot, stopConfirmed } = await loadScript<{
    snapshot: (state: Record<string, unknown>) => { messages: number; drafts: number };
    stopConfirmed: (
      state: Record<string, unknown>,
      base: { messages: number; drafts: number },
      logText: string,
      draftId: number | null,
    ) => { confirmed: boolean; by: string | null; refusal: string | null };
  }>("scripts/soak/signals.mjs");

  const base = snapshot({ messages: { 1: "welcome" }, drafts: [{ draft_id: 1 }] });

  const confirmedLog =
    "[2026-10-13T08:22:52.033Z] [INFO] [Bot] Native generation stop handled: chat=987654321, thread=10000, draft=1, result=confirmed";
  assert.deepEqual(stopConfirmed({ messages: { 1: "welcome" }, drafts: [{ draft_id: 1 }] }, base, confirmedLog, 1), {
    confirmed: true,
    by: "bot-log",
    refusal: null,
  });

  assert.deepEqual(
    stopConfirmed(
      { messages: { 1: "welcome", 2: "ran to completion anyway" }, drafts: [{ draft_id: 1 }] },
      base,
      "",
      1,
    ),
    { confirmed: false, by: null, refusal: null },
    "a message published after the press is ambiguous: the run may simply have finished, which is exactly what a refused Stop looked like in run 38368783928",
  );

  const refusedLog =
    "[2026-10-13T08:22:52.033Z] [INFO] [Bot] Native generation stop handled: chat=987654321, thread=10000, draft=4, result=stale-draft";
  assert.deepEqual(
    stopConfirmed({ messages: { 1: "welcome" }, drafts: [{ draft_id: 1 }] }, base, refusedLog, 4),
    { confirmed: false, by: null, refusal: "stale-draft" },
    "a refusal must surface as a refusal so the run reports a failing Stop instead of waiting for the deadline",
  );

  assert.deepEqual(
    stopConfirmed(
      { messages: { 1: "welcome", 2: "partial draft" }, drafts: [{ draft_id: 1 }, { draft_id: 2 }] },
      base,
      "",
      1,
    ),
    { confirmed: false, by: null, refusal: null },
    "another draft from a generation that is still streaming is late output, never a confirmation",
  );
});

test("Stop is only issued against a draft the Bot actually registered", async () => {
  const { snapshot, draftIssued } = await loadScript<{
    snapshot: (state: Record<string, unknown>) => { messages: number; drafts: number };
    draftIssued: (state: Record<string, unknown>, base: { messages: number; drafts: number }) => boolean;
  }>("scripts/soak/signals.mjs");

  const base = snapshot({ messages: { 1: "welcome" }, drafts: [] });

  assert.equal(
    draftIssued({ messages: { 1: "welcome" }, drafts: [{ draft_id: 1, method: "sendRichMessageDraft" }] }, base),
    true,
    "the Bot registers the draft before it sends it, so the recorded draft_id is Stop's attribution key",
  );
  assert.equal(
    draftIssued({ messages: { 1: "welcome", 2: "published reply" }, drafts: [] }, base),
    false,
    "a published message is not a draft: stopping it produced `unknown-draft` in run 38368783928",
  );
});

test("late output is measured by Telegram output calls, not by message count alone", async () => {
  const { outputCalls } = await loadScript<{
    outputCalls: (state: Record<string, unknown>) => number;
  }>("scripts/soak/signals.mjs");

  const state = {
    counters: {
      getUpdates: 40,
      sendChatAction: 6,
      sendMessageDraft: 2,
      sendRichMessageDraft: 3,
      editMessageText: 11,
      sendMessage: 4,
    },
  };
  assert.equal(
    outputCalls(state),
    20,
    "edits and drafts are output the stopped run must stop producing; getUpdates/typing polls are not",
  );
  assert.equal(outputCalls({ counters: {} }), 0);
});

test("a Topic counts as created only when an id absent from the baseline appears", async () => {
  const { newThreadId } = await loadScript<{
    newThreadId: (state: Record<string, unknown>, base: { threads?: Array<number | string> }) => number | null;
  }>("scripts/soak/signals.mjs");

  const base = { threads: [10152] };
  assert.equal(newThreadId({ threads: { "Chat #154": 10153 } }, base), 10153);
  assert.equal(
    newThreadId({ threads: { "Chat #153": 10152 } }, base),
    null,
    "the previous cycle's deleted Topic still being the newest id is not a Topic being created — that is how stress run 38370753677 prompted a deleted Topic twice in 167 cycles and the Bot refused it as stale metadata, losing W2, W5 and W6 with it",
  );
  assert.equal(newThreadId({ threads: {} }, { threads: [] }), null);
  assert.equal(
    newThreadId({ threads: { "Chat #153": 10152, "Chat #154": 10153 } }, base),
    10153,
    "when several ids are new the highest is the one just created",
  );
});

test("W6 evidence separates a delete of a live Topic from an idle or foreign one", async () => {
  const { deleteOutcome } = await loadScript<{
    deleteOutcome: (
      logText: string,
      threadId: number | string,
    ) => { requested: boolean; completed: boolean; interrupted: boolean };
  }>("scripts/soak/signals.mjs");

  const liveLog = [
    "[2026-10-13T08:35:31.100Z] [INFO] [TelegramTopics] Delete requested during active run; cancelling current run first: session=ses_a, thread=10000",
    "[2026-10-13T08:35:32.200Z] [INFO] [TelegramTopics] Delete confirmation completed: session=ses_a, thread=10000",
  ].join("\n");

  assert.deepEqual(deleteOutcome(liveLog, 10000), {
    requested: true,
    completed: true,
    interrupted: false,
  });
  assert.deepEqual(
    deleteOutcome(liveLog, 20000),
    { requested: false, completed: false, interrupted: false },
    "another Topic's delete must never satisfy this Topic's evidence",
  );

  assert.equal(
    deleteOutcome("[..] Delete confirmation completed: session=ses_a, thread=10000", 10000).requested,
    false,
    "W6 is registered as Delete Chat *while its run is active*; deleting an idle Topic is a different workload and must be reported as such",
  );

  const interruptedLog = `${liveLog}\n[..] [ERROR] [TelegramTopics] Topic deletion stopped at a retry-safe cleanup boundary: session=ses_a, thread=10000`;
  assert.equal(deleteOutcome(interruptedLog, 10000).interrupted, true);
});

test("a deleted Topic is observed as gone, so cleanup is asserted rather than inferred", async () => {
  const { topicGone } = await loadScript<{
    topicGone: (state: Record<string, unknown>, threadId: number | string) => boolean;
  }>("scripts/soak/signals.mjs");

  assert.equal(topicGone({ threads: { "New Chat": 10000 } }, 10000), false);
  assert.equal(topicGone({ threads: {} }, 10000), true);
  assert.equal(topicGone({ threads: { "New Chat": 20000 } }, 10000), true);
  assert.equal(topicGone({}, 10000), true);
});

test("a controlled restart counts only when the Bot answers again within D5 and its pid changed", async () => {
  const { restartOutcome } = await loadScript<{
    restartOutcome: (input: {
      base: { messages: number; drafts: number };
      state: Record<string, unknown>;
      beforePid: number | null;
      afterPid: number | null;
      elapsedMs: number;
      limitMs: number;
      bootMs?: number;
      answerMs?: number;
    }) => {
      answered: boolean;
      pidChanged: boolean;
      withinD5: boolean;
      answeredAfterBoot: boolean;
      pass: boolean;
    };
  }>("scripts/soak/signals.mjs");

  const base = { messages: 1, drafts: 0 };
  const bootMs = 1_000_000;
  assert.deepEqual(
    restartOutcome({
      base,
      state: { messages: { 1: "welcome", 2: "restarted" }, drafts: [] },
      beforePid: 111,
      afterPid: 222,
      elapsedMs: 9_000,
      limitMs: 120_000,
      bootMs,
      answerMs: 1_009_000,
    }),
    { answered: true, pidChanged: true, withinD5: true, answeredAfterBoot: true, pass: true },
  );

  assert.deepEqual(
    restartOutcome({
      base,
      state: { messages: { 1: "welcome" }, drafts: [] },
      beforePid: 111,
      afterPid: 222,
      elapsedMs: 9_000,
      limitMs: 120_000,
      bootMs,
      answerMs: Number.NaN,
    }),
    { answered: false, pidChanged: true, withinD5: true, answeredAfterBoot: false, pass: false },
    "a Bot that came back but answers nothing is not a successful restart",
  );

  assert.deepEqual(
    restartOutcome({
      base,
      state: { messages: { 1: "welcome", 2: "restarted" }, drafts: [] },
      beforePid: 111,
      afterPid: 111,
      elapsedMs: 9_000,
      limitMs: 120_000,
      bootMs,
      answerMs: 1_009_000,
    }),
    { answered: true, pidChanged: false, withinD5: true, answeredAfterBoot: true, pass: false },
    "an unchanged pid means the old process never died, so nothing was restarted",
  );

  assert.deepEqual(
    restartOutcome({
      base,
      state: { messages: { 1: "welcome", 2: "restarted" }, drafts: [] },
      beforePid: 111,
      afterPid: 222,
      elapsedMs: 150_000,
      limitMs: 120_000,
      bootMs,
      answerMs: 1_150_000,
    }),
    { answered: true, pidChanged: true, withinD5: false, answeredAfterBoot: true, pass: false },
    "D5 is a registered deadline: missing it is F8 even when the answer eventually arrives",
  );

  assert.deepEqual(
    restartOutcome({
      base,
      state: { messages: { 1: "welcome", 2: "output of the run that was just stopped" }, drafts: [] },
      beforePid: 111,
      afterPid: 222,
      elapsedMs: 13_029,
      limitMs: 120_000,
      bootMs: 1_000_000,
      answerMs: 999_000,
    }),
    {
      answered: true,
      pidChanged: true,
      withinD5: true,
      answeredAfterBoot: false,
      pass: false,
    },
    "growth observed before the new Bot's own boot line cannot be the new Bot answering — run 38372649512 resolved readyMs=13029 at 10:41:20.83 while the new Bot's first log line is 10:41:21.109: the process that was just stopped was still finishing its run",
  );
});

test("an update served to a client that never confirmed it is served again, until its offset acks it", async () => {
  const { serveBatch } = await loadScript<{
    serveBatch: (
      entries: Array<{ update_id: number }>,
      offset: number,
      limit: number,
    ) => { batch: Array<{ update_id: number }>; queue: Array<{ update_id: number }> };
  }>("scripts/soak/update-queue.mjs");

  const entries = [{ update_id: 1000004 }, { update_id: 1000005 }];

  const served = serveBatch(entries, 1000004, 100);
  assert.deepEqual(served.batch, entries, "the two updates are what the poll hands to the client");
  assert.deepEqual(
    served.queue,
    entries,
    "handing them over does not remove them: stress run 38372649512 served 1000004+1000005 to a long-poll whose process had already exited, and the new Bot's first poll then saw an empty queue and waited 60s",
  );

  const redelivered = serveBatch(served.queue, Number.NaN, 100);
  assert.deepEqual(
    redelivered.batch,
    entries,
    "a fresh client asking without an offset is owed everything unacked — Telegram's own contract is at-least-once until offset",
  );

  const acked = serveBatch(redelivered.queue, 1000006, 100);
  assert.deepEqual(acked.batch, [], "once the client acks past them they are gone");
  assert.deepEqual(acked.queue, [], "an ack is the only thing that empties the queue");

  const partial = serveBatch([{ update_id: 4 }, { update_id: 5 }, { update_id: 6 }], Number.NaN, 1);
  assert.deepEqual(partial.batch.map((e) => e.update_id), [4], "limit still caps what one poll returns");
  const afterPartialAck = serveBatch(partial.queue, 5, 100);
  assert.deepEqual(
    afterPartialAck.batch.map((e) => e.update_id),
    [5, 6],
    "a client that acked 4 must not be given 4 again, and must be given the rest",
  );
});

test("persist-evidence pushes to GitHub with the checkout's credentials and never hides the reason", async () => {
  const { readFileSync } = await import("node:fs");
  const script = readFileSync(new URL("../scripts/soak/persist-evidence.sh", import.meta.url), "utf8");

  assert.ok(
    !/git push[^\n]*2>\/dev\/null/.test(script),
    "swallowing push stderr left two soak runs reporting 'push failed after 3 attempts (offline?)' with no reason — a durability gate (E6) cannot be audited if the cause is discarded",
  );
  assert.ok(
    /\bpush\b[^\n]*\$REMOTE/.test(script),
    "after the file:// seed clone, `origin` points at the local checkout: a push there succeeds locally and never reaches GitHub, so the push must target the remote URL",
  );
  assert.ok(
    /extraheader/.test(script),
    "actions/checkout stores the token in http.https://github.com/.extraheader of the parent repo; a fresh clone does not inherit it, so the push must pass it explicitly",
  );
});

test("D2 counts streaming output only, because finalising the stopped draft is legitimate", async () => {
  const { streamCalls } = await loadScript<{
    streamCalls: (state: Record<string, unknown>) => number;
  }>("scripts/soak/signals.mjs");

  const state = {
    counters: {
      getUpdates: 40,
      sendChatAction: 6,
      sendMessageDraft: 2,
      sendRichMessageDraft: 3,
      editMessageText: 11,
      sendMessage: 4,
    },
  };
  assert.equal(
    streamCalls(state),
    16,
    "publishing the stopped draft as a message is the confirmation itself; a run still streaming after the stop is the violation",
  );
});

test("the RC soak alternates long active and idle phases, and continuous stages stay continuous", async () => {
  const { phaseFor } = await loadScript<{
    phaseFor: (elapsedS: number, activeS: number, idleS: number) => "active" | "idle";
  }>("scripts/soak/signals.mjs");

  // Registered as "cycles spread over 24 h with active and idle phases"
  // (SOAK_GATES.md §2): a phase must be a contiguous window, not the 15 s gap
  // between two back-to-back cycles.
  assert.equal(phaseFor(0, 2700, 900), "active");
  assert.equal(phaseFor(2699.9, 2700, 900), "active", "the active window closes at activeS");
  assert.equal(phaseFor(2700, 2700, 900), "idle", "elapsed == activeS is already idle");
  assert.equal(phaseFor(3599, 2700, 900), "idle", "the idle window closes at activeS+idleS");
  assert.equal(phaseFor(3600, 2700, 900), "active", "the next window restarts the cycle");
  assert.equal(phaseFor(6300, 2700, 900), "idle", "phase windows repeat");
  assert.equal(phaseFor(4500, 2700, 900), "active", "window arithmetic is modulo, not cumulative");

  // A stress stage registers no phase plan and must keep running back-to-back
  // cycles: no idle window may ever appear from an absent or incomplete plan.
  assert.equal(phaseFor(5000, 0, 0), "active");
  assert.equal(phaseFor(5000, 2700, 0), "active", "an idle length of 0 leaves nothing idle");
  assert.equal(phaseFor(5000, 0, 900), "active", "an active length of 0 would leave no work at all, so it is not a plan");
});

test("system memory is read as measured facts, with absence reported as absence", async () => {
  const { parseMeminfo } = await loadScript<{
    parseMeminfo: (text: string) => { memTotalKb: number | null; memAvailableKb: number | null };
  }>("scripts/soak/signals.mjs");

  assert.deepEqual(
    parseMeminfo(
      "MemTotal:       16331288 kB\nMemFree:         1472044 kB\nMemAvailable:    8234560 kB\nBuffers:          409824 kB\n",
    ),
    { memTotalKb: 16331288, memAvailableKb: 8234560 },
    "the two §8 columns (headroom ceiling and headroom now) come straight from /proc/meminfo",
  );
  assert.deepEqual(
    parseMeminfo("MemTotal:       16331288 kB\n"),
    { memTotalKb: 16331288, memAvailableKb: null },
    "a host without MemAvailable must yield an unknown headroom, never a zero",
  );
  assert.deepEqual(
    parseMeminfo(""),
    { memTotalKb: null, memAvailableKb: null },
    "an unreadable file is recorded as not measured",
  );
  assert.deepEqual(
    parseMeminfo("MemAvailable:   not-a-number kB"),
    { memTotalKb: null, memAvailableKb: null },
    "garbage is absence, not a plausible-looking figure",
  );
});

test("cumulative CPU time parses every ps TIME shape and refuses to invent one", async () => {
  const { cputimeSeconds } = await loadScript<{
    cputimeSeconds: (text: string) => number | null;
  }>("scripts/soak/signals.mjs");

  assert.equal(cputimeSeconds("0:05"), 5, "mm:ss");
  assert.equal(cputimeSeconds("1:02:03"), 3723, "hh:mm:ss");
  assert.equal(cputimeSeconds("01:02:03.45"), 3723.45, "hh:mm:ss.cc as BSD time renders it");
  assert.equal(cputimeSeconds("2-03:04:05"), 183845, "dd-hh:mm:ss on a long-lived process");
  assert.equal(cputimeSeconds("0:00"), 0, "an idle process has consumed nothing, which is a measurement");
  assert.equal(cputimeSeconds(""), null, "absent is not zero");
  assert.equal(cputimeSeconds("running"), null, "unparseable is not a plausible figure");
});

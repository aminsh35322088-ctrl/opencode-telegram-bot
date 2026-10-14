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
      sinceIso: string,
    ) => { confirmed: boolean; by: string | null; refusal: string | null };
  }>("scripts/soak/signals.mjs");

  const base = snapshot({ messages: { 1: "welcome" }, drafts: [{ draft_id: 1 }] });
  const sinceIso = "2026-10-13T08:22:00.000Z";

  const confirmedLog =
    "[2026-10-13T08:22:52.033Z] [INFO] [Bot] Native generation stop handled: chat=987654321, thread=10000, draft=1, result=confirmed";
  assert.deepEqual(stopConfirmed({ messages: { 1: "welcome" }, drafts: [{ draft_id: 1 }] }, base, confirmedLog, 1, sinceIso), {
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
      sinceIso,
    ),
    { confirmed: false, by: null, refusal: null },
    "a message published after the press is ambiguous: the run may simply have finished, which is exactly what a refused Stop looked like in run 38368783928",
  );

  const refusedLog =
    "[2026-10-13T08:22:52.033Z] [INFO] [Bot] Native generation stop handled: chat=987654321, thread=10000, draft=4, result=stale-draft";
  assert.deepEqual(
    stopConfirmed({ messages: { 1: "welcome" }, drafts: [{ draft_id: 1 }] }, base, refusedLog, 4, sinceIso),
    { confirmed: false, by: null, refusal: "stale-draft" },
    "a refusal must surface as a refusal so the run reports a failing Stop instead of waiting for the deadline",
  );

  assert.deepEqual(
    stopConfirmed(
      { messages: { 1: "welcome", 2: "partial draft" }, drafts: [{ draft_id: 1 }, { draft_id: 2 }] },
      base,
      "",
      1,
      sinceIso,
    ),
    { confirmed: false, by: null, refusal: null },
    "another draft from a generation that is still streaming is late output, never a confirmation",
  );
});

test("a Stop may only be confirmed by a line the Bot wrote after this press", async () => {
  const { stopConfirmed } = await loadScript<{
    stopConfirmed: (
      state: Record<string, unknown>,
      base: { messages: number; drafts: number },
      logText: string,
      draftId: number | null,
      sinceIso: string,
    ) => { confirmed: boolean; by: string | null; refusal: string | null };
  }>("scripts/soak/signals.mjs");

  // Run 38403749350: W7 restarted the Bot mid-cycle and the new process's
  // draft-id counter started over (…27, 31 → 1, 4, 7). The pre-restart
  // confirmations were still in the same bot.log, so the first `draft=1,
  // result=confirmed` in the tail was cycle 1's line from 13:18:08 — W5's
  // Stop "confirmed" 2 ms after the press, before the Bot had seen it, and
  // the still-streaming run was then charged to D2 (`withinD2:false`,
  // `lateDelta:1`). Attribution belongs to this press: a line written
  // before it is history, however well it matches.
  const state = { messages: {}, drafts: [{ draft_id: 1 }] };
  const base = { messages: 0, drafts: 0 };
  const pressIso = "2026-10-13T13:26:06.600Z";
  const staleConfirm =
    "[2026-10-13T13:18:08.827Z] [INFO] [Bot] Native generation stop handled: chat=987654321, thread=10000, draft=1, result=confirmed";
  const realConfirm =
    "[2026-10-13T13:26:07.208Z] [INFO] [Bot] Native generation stop handled: chat=987654321, thread=10018, draft=1, result=confirmed";

  assert.deepEqual(
    stopConfirmed(state, base, staleConfirm, 1, pressIso),
    { confirmed: false, by: null, refusal: null },
    "a confirmation written before the press cannot confirm this Stop",
  );
  assert.deepEqual(
    stopConfirmed(state, base, `${staleConfirm}\n${realConfirm}`, 1, pressIso),
    { confirmed: true, by: "bot-log", refusal: null },
    "the Bot's own line after the press confirms; the history before it is ignored",
  );
  assert.deepEqual(
    stopConfirmed(state, base, "[2026-10-13T13:18:08.827Z] [INFO] [Bot] Native generation stop handled: chat=987654321, thread=10000, draft=1, result=stale-draft", 1, pressIso),
    { confirmed: false, by: null, refusal: null },
    "a refusal from before the press must not fail this Stop either",
  );
  assert.deepEqual(
    stopConfirmed(state, base, realConfirm, 1, "not-a-timestamp"),
    { confirmed: false, by: null, refusal: null },
    "an unattributable window never confirms",
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

test("the workload may only act at rest, and never claims rest it did not observe", async () => {
  const { restState } = await loadScript<{
    restState: (
      samples: Array<{ t: number; calls: number }>,
      stableMs: number,
    ) => { atRest: boolean; quietMs: number };
  }>("scripts/soak/signals.mjs");

  // Stress run 38393992089: the next cycle's New Chat arrived while the
  // previous cycle's answer tail was still streaming, the Bot's menuAllowed
  // guard saw an active run, and the press — already deleted by the router —
  // was dropped with no reply. Rest is the workload's precondition; it must be
  // waited for, not raced for.
  assert.deepEqual(
    restState([], 5000),
    { atRest: false, quietMs: 0 },
    "no observation is not rest",
  );
  assert.deepEqual(
    restState([{ t: 1000, calls: 7 }], 5000),
    { atRest: false, quietMs: 0 },
    "a single reading cannot show stability",
  );
  assert.deepEqual(
    restState(
      [
        { t: 1000, calls: 7 },
        { t: 3500, calls: 7 },
        { t: 6000, calls: 7 },
      ],
      5000,
    ),
    { atRest: true, quietMs: 5000 },
    "5s without a single output growth is rest",
  );
  assert.equal(
    restState(
      [
        { t: 1000, calls: 7 },
        { t: 6000, calls: 7 },
      ],
      5000,
    ).atRest,
    true,
    "the boundary counts as rest",
  );
  assert.equal(
    restState(
      [
        { t: 1000, calls: 7 },
        { t: 3500, calls: 7 },
        { t: 5000, calls: 8 },
      ],
      5000,
    ).atRest,
    false,
    "any growth, up or down, restarts the clock",
  );
  assert.deepEqual(
    restState(
      [
        { t: 1000, calls: 7 },
        { t: 2000, calls: 8 },
        { t: 7000, calls: 8 },
        { t: 8000, calls: 8 },
      ],
      5000,
    ),
    { atRest: true, quietMs: 6000 },
    "quiet time is measured from the last growth, never from the first sample",
  );
});

test("the verdict tally cannot lose a flow it was given, nor pass an unknown status", async () => {
  const { tallyResults } = await loadScript<{
    tallyResults: (summaries: unknown[]) => {
      counts: Record<string, number>;
      unrecognized: number;
    };
  }>("scripts/soak/signals.mjs");

  // Run 38397066002 (evidence/20261013T124702Z-soak) reported success while
  // cycles.jsonl held `W1 ... fail: new topic id timed out after 60000ms`:
  // the tally could only count what reached it, and cycle() never collected
  // flowNewChat()'s return, so the exit code was built from a picture with
  // the failure missing. A status the tally cannot name — a missing one
  // included — must show up as `unrecognized`, never as silence.
  const { counts, unrecognized } = tallyResults([
    { results: [{ status: "pass" }, { status: "fail" }, { status: "not-executed" }] },
    { status: "pass" }, // the smoke stage pushes a bare record
  ]);
  assert.deepEqual(counts, { pass: 2, fail: 1, "not-executed": 1 });
  assert.equal(unrecognized, 0);

  const gap = tallyResults([{ results: [{ status: "pass" }, { threadId: 10000 }] }]);
  assert.deepEqual(gap.counts, { pass: 1, "fail": 0, "not-executed": 0 });
  assert.equal(gap.unrecognized, 1, "a record without a status must be seen, not skipped");

  const odd = tallyResults([{ results: [{ status: "exploded" }] }]);
  assert.equal(odd.unrecognized, 1, "an unknown status must not be counted as anything else");
});

test("cycle() collects every flow's record, W1's included", async () => {
  const { readFileSync } = await import("node:fs");

  // The same run 38397066002: every other flow's return was pushed into
  // `results`, flowNewChat's was not — W1's status reached cycles.jsonl and
  // never reached summary.json, so the workflow verdict did not know a gate
  // had failed. The driver runs main() on import and cannot be loaded in a
  // test, so the wiring is pinned at source level here, the same way
  // persist-evidence.sh is pinned in this file.
  const driver = readFileSync(new URL("../scripts/soak/driver.mjs", import.meta.url), "utf8");
  assert.match(
    driver,
    /const chat = await flowNewChat\(\);\s*results\.push\(chat\);/,
    "the W1 record must be collected like every other flow's",
  );
  assert.match(
    driver,
    /return \{ \.\.\.pass, threadId: r\.value \};/,
    "the W1 pass path must return its record: a bare { threadId } carries no status",
  );
});

test("df and du output parsers fail closed and preserve byte and inode measurements", async () => {
  const { parseDfOutput, parseDuTotal } = await loadScript<{
    parseDfOutput: (text: string) => {
      sizeB: number | null;
      usedB: number | null;
      availB: number | null;
      pcent: number | null;
      target: string | null;
    };
    parseDuTotal: (text: string) => number | null;
  }>("scripts/soak/signals.mjs");

  assert.deepEqual(
    parseDfOutput("  1B-blocks      Used       Avail Use% Mounted on\n1000000 250000 750000 25% /state\n"),
    { sizeB: 1_000_000, usedB: 250_000, availB: 750_000, pcent: 25, target: "/state" },
  );
  assert.deepEqual(parseDfOutput("Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/root 1000 250 750 25% /state\n"), {
    sizeB: null, usedB: null, availB: null, pcent: null, target: null,
  });
  assert.deepEqual(parseDfOutput(""), { sizeB: null, usedB: null, availB: null, pcent: null, target: null });
  assert.equal(parseDuTotal("123456\t/workspaces\n"), 123456);
  assert.equal(parseDuTotal("du: cannot access '/missing': No such file or directory\n"), null);
  assert.equal(parseDuTotal("not bytes\t/workspaces\n"), null);
});

test("resource samples measure disk every tick and workspace size only on cycle samples", async () => {
  const { readFileSync } = await import("node:fs");
  const driver = readFileSync(new URL("../scripts/soak/driver.mjs", import.meta.url), "utf8");
  assert.match(driver, /df[^\n]*-B1[^\n]*--output=size,used,avail,pcent,target/);
  assert.match(driver, /out\("df", \["-i", stateDir\]\)/);
  assert.match(driver, /du[^\n]*-sb/);
  assert.match(driver, /const workspaceDir = join\(stateDir, "opencode", "topic-workspaces"\)/);
  assert.match(driver, /readdirSync\(workspaceDir\)/);
  assert.match(driver, /diskBytes:[^\n]*sizeB/);
  assert.match(driver, /inodesFree: inodeRow \? Number\(inodeRow\[1\]\)/);
  assert.match(driver, /workspaceCount = readdirSync\(workspaceDir\)\.length/);
  assert.match(driver, /workspaceBytes = parseDuTotal/);
  assert.match(driver, /topicLatencyMs/);
});

test("G8 rollback timeline requires a post-boot answer and enforces D6", async () => {
  const { rollbackTimeline } = await loadScript<{
    rollbackTimeline: (events: Record<string, number | null>, d6Ms: number) => Record<string, unknown>;
  }>("scripts/soak/signals.mjs");
  const complete = {
    stop: 1000, checkout: 2000, build: 4000, spawn: 5000, boot: 6000, answer: 7000,
    restoreStop: 8000, restoreBoot: 10000, restoreAnswer: 11000,
  };
  assert.deepEqual(rollbackTimeline(complete, 300_000), {
    rollbackMs: 6000, withinD6: true, checkoutMs: 1000, buildMs: 2000, spawnMs: 1000,
    bootAfterStop: true, answerAfterBoot: true, restoreMs: 3000, restoreServing: true,
  });
  assert.equal(rollbackTimeline({ ...complete, answer: 301_001 }, 300_000).withinD6, false);
  assert.equal(rollbackTimeline({ ...complete, answer: null }, 300_000).rollbackMs, null);
  assert.equal(rollbackTimeline({ ...complete, stop: null }, 300_000).withinD6, false);
  assert.equal(rollbackTimeline({ ...complete, checkout: null, build: null, spawn: null }, 300_000).withinD6, true);
  assert.equal(rollbackTimeline({ ...complete, boot: 7100 }, 300_000).answerAfterBoot, false);
  assert.equal(rollbackTimeline({ ...complete, boot: 900 }, 300_000).bootAfterStop, false);
  assert.equal(rollbackTimeline({ ...complete, restoreAnswer: 9000 }, 300_000).restoreServing, false);
  assert.equal(rollbackTimeline({ ...complete, restoreBoot: 7000 }, 300_000).restoreServing, false);
  assert.equal(rollbackTimeline({ ...complete, restoreStop: null }, 300_000).restoreServing, false);
});

test("only the latest completed CI run for the exact SHA can qualify rollback", async () => {
  const { qualifiesCiRun } = await loadScript<{
    qualifiesCiRun: (payload: unknown, sha: string) => Record<string, unknown>;
  }>("scripts/soak/signals.mjs");
  const green = { id: 10, run_number: 12, head_sha: "abc123", status: "completed", conclusion: "success" };
  assert.deepEqual(qualifiesCiRun({ workflow_runs: [green] }, "abc123"), {
    qualified: true, runId: 10, runNumber: 12, conclusion: "success", headSha: "abc123", reason: "latest ci.yml run succeeded",
  });
  assert.equal(qualifiesCiRun({ workflow_runs: [green] }, "ABC123").qualified, false);
  assert.equal(qualifiesCiRun({ workflow_runs: [
    { ...green, id: 11, run_number: 13, conclusion: "failure" }, green,
  ] }, "abc123").qualified, false, "a later failure revokes an earlier green run");
  assert.equal(qualifiesCiRun({ workflow_runs: [{ ...green, status: "in_progress", conclusion: null }] }, "abc123").qualified, false);
  assert.equal(qualifiesCiRun({ workflow_runs: [] }, "abc123").qualified, false);
});

test("rollback preflight rejects every unqualified target and records ancestry without gating", async () => {
  const { rollbackPreflight } = await loadScript<{
    rollbackPreflight: (input: Record<string, unknown>) => { ok: boolean; reason: string; isAncestor: boolean | null };
  }>("scripts/soak/signals.mjs");
  const base = { supplied: true, rollbackSha: "old", testedSha: "new", resolvable: true, isAncestor: true, ci: { qualified: true, reason: "green" } };
  assert.deepEqual(rollbackPreflight({ ...base, supplied: false }), {
    ok: false, reason: "no qualified rollback target: rollbackSha not supplied", isAncestor: true,
  });
  assert.equal(rollbackPreflight({ ...base, rollbackSha: "new" }).reason, "no qualified rollback target: rollbackSha equals testedSha");
  assert.equal(rollbackPreflight({ ...base, resolvable: false }).reason, "no qualified rollback target: rollbackSha is not a resolvable commit");
  assert.equal(rollbackPreflight({ ...base, ci: { qualified: false, reason: "CI run is in progress" } }).reason,
    "no qualified rollback target: CI run is in progress");
  assert.deepEqual(rollbackPreflight({ ...base, isAncestor: false }), { ok: true, reason: "qualified", isAncestor: false });
  assert.deepEqual(rollbackPreflight(base), { ok: true, reason: "qualified", isAncestor: true });
});

test("rollback script markers parse phase timings and exit status", async () => {
  const { parseRollbackScript } = await loadScript<{
    parseRollbackScript: (logText: string) => Record<string, unknown>;
  }>("scripts/soak/signals.mjs");
  assert.deepEqual(parseRollbackScript(
    "bot-rollback: phase=rollback sha=abc123 checkout=100 build=200 spawn=300\nbot-rollback: exit=0\n",
  ), { exit: 0, sha: "abc123", checkout: 100, build: 200, spawn: 300 });
  assert.deepEqual(parseRollbackScript("bot-rollback: phase=restore sha=def456 checkout=12 build=34 spawn=56\n"), {
    exit: null, sha: "def456", checkout: 12, build: 34, spawn: 56,
  });
});

test("G8 source and workflow plumbing pin rollback SHA and call the rollback flow", async () => {
  const { readFileSync } = await import("node:fs");
  const rollbackScript = readFileSync(new URL("../scripts/soak/bot-rollback.sh", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/soak.yml", import.meta.url), "utf8");
  const runScript = readFileSync(new URL("../scripts/soak/run.sh", import.meta.url), "utf8");
  const driver = readFileSync(new URL("../scripts/soak/driver.mjs", import.meta.url), "utf8");
  assert.match(rollbackScript, /\$\{4:\?[^}]*sha required/);
  assert.doesNotMatch(rollbackScript, /HEAD(?:\^|~)/);
  assert.match(workflow, /rollback_sha:/);
  assert.match(workflow, /ROLLBACK_SHA:/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /OC_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /chmod \+x[^\n]*bot-rollback\.sh/);
  assert.match(runScript, /--rollback-script "\$SOAK\/bot-rollback\.sh"/);
  assert.match(driver, /results\.push\(await flowRollback\(\)\)/);
});

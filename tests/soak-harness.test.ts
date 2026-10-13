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
    }) => { answered: boolean; pidChanged: boolean; withinD5: boolean; pass: boolean };
  }>("scripts/soak/signals.mjs");

  const base = { messages: 1, drafts: 0 };
  assert.deepEqual(
    restartOutcome({
      base,
      state: { messages: { 1: "welcome", 2: "restarted" }, drafts: [] },
      beforePid: 111,
      afterPid: 222,
      elapsedMs: 9_000,
      limitMs: 120_000,
    }),
    { answered: true, pidChanged: true, withinD5: true, pass: true },
  );

  assert.deepEqual(
    restartOutcome({
      base,
      state: { messages: { 1: "welcome" }, drafts: [] },
      beforePid: 111,
      afterPid: 222,
      elapsedMs: 9_000,
      limitMs: 120_000,
    }),
    { answered: false, pidChanged: true, withinD5: true, pass: false },
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
    }),
    { answered: true, pidChanged: false, withinD5: true, pass: false },
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
    }),
    { answered: true, pidChanged: true, withinD5: false, pass: false },
    "D5 is a registered deadline: missing it is F8 even when the answer eventually arrives",
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

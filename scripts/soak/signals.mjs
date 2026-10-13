// Observation signals for the soak driver.
//
// Pure functions over the stub's `/__state` snapshot plus the Bot's own log,
// so the "did the run actually stop?" decision is testable instead of being
// buried in a polling loop. The rule these encode: a flow is only ever
// reported from something that was observed; nothing is inferred.

export function snapshot(state) {
  return {
    messages: Object.keys(state?.messages ?? {}).length,
    drafts: (state?.drafts ?? []).length,
    threads: Object.values(state?.threads ?? {}),
  };
}

// A Topic is created when an id that did not exist at the baseline appears —
// never when "something happened". The Bot needs seconds to create the
// workspace, session and binding, and it sends other messages first, so a
// growth-based wait let the driver read the previous cycle's *deleted* Topic
// as the newest one: stress run 38370753677 lost this race in 2 of 167 cycles,
// prompted the deleted Topic, and the Bot correctly refused it as stale
// metadata — taking W2, W5 and W6 down with it.
export function newThreadId(state, base) {
  const known = new Set((base?.threads ?? []).map(String));
  const created = Object.values(state?.threads ?? {})
    .map(Number)
    .filter((id) => Number.isFinite(id) && !known.has(String(id)));
  return created.length > 0 ? Math.max(...created) : null;
}

// Growth since a baseline. Both flows and Stop attach to something that is
// genuinely new: an edit-mode run announces itself as a message, a draft-mode
// run as a draft — before any message exists — so both count, and a baseline
// that already counts a previous cycle's output must not match again.
export function growthObserved(state, base) {
  const now = snapshot(state);
  return now.drafts > base.drafts || now.messages > base.messages;
}

// Stop must be aimed at a draft the Bot actually registered: the Bot records
// the draft (attributing it to the current run) *before* it sends it, so the
// stub having seen the draft is the proof that the Stop will resolve. Waiting
// on a published message instead produced `unknown-draft`, because the run had
// not streamed anything yet when the message arrived.
export function draftIssued(state, base) {
  return snapshot(state).drafts > base.drafts;
}

// A Stop counts as confirmed only when the Bot itself says so, for that exact
// draft. Nothing weaker is admissible: a message published after the press is
// equally consistent with the run having finished on its own — which is
// precisely what a refused Stop looked like in cycle run 38368783928
// (`result=stale-draft`), where the run's own completion was recorded as
// confirmation. A refusal is surfaced as such so the gate reports a failing
// Stop immediately instead of waiting out the deadline.
export function stopConfirmed(state, base, logText, draftId) {
  if (draftId == null) return { confirmed: false, by: null, refusal: null };
  const match = new RegExp(`draft=${draftId}, result=([a-z-]+)`).exec(logText ?? "");
  if (!match) return { confirmed: false, by: null, refusal: null };
  if (match[1] === "confirmed") return { confirmed: true, by: "bot-log", refusal: null };
  return { confirmed: false, by: null, refusal: match[1] };
}

// Telegram output calls that a stopped run must stop producing. Polling
// (`getUpdates`) and typing indicators are not output of the run itself.
const OUTPUT_METHODS = new Set([
  "sendMessage",
  "sendRichMessage",
  "sendMessageDraft",
  "sendRichMessageDraft",
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "editMessageMedia",
  "deleteMessage",
  "pinChatMessage",
]);

export function outputCalls(state) {
  const counters = state?.counters ?? {};
  let total = 0;
  for (const [method, value] of Object.entries(counters)) {
    if (OUTPUT_METHODS.has(method)) total += Number(value) || 0;
  }
  return total;
}

// W6 is registered as "Delete a Chat while its run is active … then create a
// new Topic and assert it is served by the same Worker". The Bot records both
// halves of that precondition in its own log, so the claim is read from
// evidence instead of inferred from a callback having been answered.
export function deleteOutcome(logText, threadId) {
  const text = logText ?? "";
  const wanted = String(threadId);
  const saw = (marker) => new RegExp(`${marker}[^\\n]*thread=${wanted}\\b`).test(text);
  return {
    requested: saw("Delete requested during active run; cancelling current run first:"),
    completed: saw("Delete confirmation completed:"),
    interrupted: saw("Topic deletion stopped at a retry-safe cleanup boundary:"),
  };
}

// The stub keys forum topics by name; a deleted topic loses its mapping, so
// "the topic is gone" is an observed fact of the Telegram side of the cleanup,
// not an inference from `deleteForumTopic` having been attempted.
export function topicGone(state, threadId) {
  const wanted = String(threadId);
  return !Object.values(state?.threads ?? {}).some((id) => String(id) === wanted);
}

// W7/G7 is a controlled restart: stop the Bot, start it again, and prove the
// environment came back. "It answered" alone is not enough — the same pid means
// the old process never died and nothing was restarted, and an answer past D5
// is F8 even when it eventually arrives.
export function restartOutcome({ base, state, beforePid, afterPid, elapsedMs, limitMs }) {
  const answered = growthObserved(state, base);
  const pidChanged = beforePid != null && afterPid != null && beforePid !== afterPid;
  const withinD5 = elapsedMs <= limitMs;
  return { answered, pidChanged, withinD5, pass: answered && pidChanged && withinD5 };
}

// D2 baseline: how much of that output is the run still streaming. Finalising
// the stopped draft into a real message is the confirmation itself, so
// `sendMessage`/`sendRichMessage` are deliberately excluded.
const STREAM_METHODS = new Set([
  "sendMessageDraft",
  "sendRichMessageDraft",
  "editMessageText",
  "editMessageCaption",
  "editMessageMedia",
]);

export function streamCalls(state) {
  const counters = state?.counters ?? {};
  let total = 0;
  for (const [method, value] of Object.entries(counters)) {
    if (STREAM_METHODS.has(method)) total += Number(value) || 0;
  }
  return total;
}

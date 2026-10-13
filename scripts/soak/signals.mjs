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
  };
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

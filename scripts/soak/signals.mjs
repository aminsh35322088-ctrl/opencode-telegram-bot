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

// A Stop counts as confirmed only when something observable proves the
// cancellation: the Bot publishes the stopped draft as a message, or the
// Bot's own attribution log records `result=confirmed` for that exact draft.
// A refused Stop (`stale-draft`, `unknown-draft`, …) is never a confirmation.
export function stopConfirmed(state, base, logText, draftId) {
  const now = snapshot(state);
  // The stub stores every draft as a message too, so only growth in
  // *non-draft* messages is a published reply; a fresh draft from the
  // generation that is still streaming would otherwise confirm its own Stop.
  const published = (s) => s.messages - s.drafts;
  if (published(now) > published(base)) return { confirmed: true, by: "message" };
  if (draftId != null && new RegExp(`draft=${draftId}, result=confirmed`).test(logText ?? "")) {
    return { confirmed: true, by: "bot-log" };
  }
  return { confirmed: false, by: null };
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

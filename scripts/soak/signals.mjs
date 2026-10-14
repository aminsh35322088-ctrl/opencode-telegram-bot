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
// draft, in a line it wrote *after this press*. Nothing weaker is admissible:
// a message published after the press is equally consistent with the run
// having finished on its own — which is precisely what a refused Stop looked
// like in cycle run 38368783928 (`result=stale-draft`), where the run's own
// completion was recorded as confirmation. And matching across the press is
// still not enough by position alone: the Bot's draft-id counter restarts
// with the process, so run 38403749350's W7 restart made the new Bot issue
// draft ids 1, 4, 7 again while the old confirmations sat in the same
// bot.log — the first `draft=1, result=confirmed` was cycle 1's line from
// 13:18:08 and the Stop "confirmed" 2 ms after the press, before the Bot had
// seen it. A refusal surfaced before the press is history too, not this
// Stop's verdict. An unparseable window never confirms: attribution that
// cannot be established must fail closed.
export function stopConfirmed(state, base, logText, draftId, sinceIso) {
  if (draftId == null) return { confirmed: false, by: null, refusal: null };
  const sinceMs = Date.parse(sinceIso ?? "");
  if (!Number.isFinite(sinceMs)) return { confirmed: false, by: null, refusal: null };
  for (const line of String(logText ?? "").split("\n")) {
    if (!line.includes(`draft=${draftId}, result=`)) continue;
    const stamp = /^\[([^\]]+)\]/.exec(line);
    if (!stamp) continue; // no timestamp, no attribution to this press
    const atMs = Date.parse(stamp[1]);
    if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
    const result = /result=([a-z-]+)/.exec(line)?.[1] ?? null;
    if (result === "confirmed") return { confirmed: true, by: "bot-log", refusal: null };
    return { confirmed: false, by: null, refusal: result };
  }
  return { confirmed: false, by: null, refusal: null };
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
//
// The answer must also postdate the new Bot's own boot line. Growth observed
// before that line is not the new Bot answering: run 38372649512 resolved
// readyMs=13029 at 10:41:20.83 while the new Bot's first log line is
// 10:41:21.109 — what grew was the process that had just been stopped, still
// finishing its run, and the driver then measured "the environment came back"
// against a Bot that had not booted yet.
export function restartOutcome({
  base,
  state,
  beforePid,
  afterPid,
  elapsedMs,
  limitMs,
  bootMs,
  answerMs,
}) {
  const answered = growthObserved(state, base);
  const pidChanged = beforePid != null && afterPid != null && beforePid !== afterPid;
  const withinD5 = elapsedMs <= limitMs;
  const answeredAfterBoot =
    Number.isFinite(bootMs) && Number.isFinite(answerMs) && answerMs >= bootMs;
  return {
    answered,
    pidChanged,
    withinD5,
    answeredAfterBoot,
    pass: answered && pidChanged && withinD5 && answeredAfterBoot,
  };
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

// Rest, as the workload must observe it before pressing a control the Bot
// drops silently during an active run (reply-keyboard-router `menuAllowed`
// returns false and the router has already deleted the pressed button). The
// caller samples a monotonic signature — Telegram output calls plus streamed
// completions — and this decides whether it has been stable for `stableMs`.
// Any change resets the clock, so a press can never be justified by a gap
// between two bursts of activity that the samples straddled.
export function restState(samples, stableMs) {
  if (!samples || samples.length === 0) return { atRest: false, quietMs: 0 };
  let lastGrowth = samples[0].t;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].calls !== samples[i - 1].calls) lastGrowth = samples[i].t;
  }
  const quietMs = samples[samples.length - 1].t - lastGrowth;
  return { atRest: quietMs >= stableMs, quietMs };
}

// The verdict tally. `summaries` holds per-cycle summaries (`{results: [...]}`)
// and bare records (the smoke stage pushes one directly). A status this does
// not name — including a missing one — is reported as `unrecognized` instead
// of dropped: run 38397066002 reported success while W1 had failed, because a
// record that was never collected cannot be counted, and a status silently
// written to `counts[undefined]` could not be either. The driver exits
// non-zero while `unrecognized > 0`, so a hole in the picture fails closed.
export function tallyResults(summaries) {
  const counts = { pass: 0, fail: 0, "not-executed": 0 };
  let unrecognized = 0;
  for (const s of summaries ?? []) {
    const list = (s && s.results) || [s];
    for (const r of list ?? []) {
      if (r && Object.hasOwn(counts, r.status)) counts[r.status] += 1;
      else unrecognized += 1;
    }
  }
  return { counts, unrecognized };
}

// RC soak phasing (SOAK_GATES.md §2: "cycles spread over 24 h with active and
// idle phases"). A phase is a contiguous window measured from the stage's own
// start — not the 15 s gap between two back-to-back cycles, which is a pause,
// not an idle phase: nothing observably happens at rest in 15 s, so RSS, CPU
// and headroom would never be seen un-stressed. An absent or incomplete plan
// (a stress stage registers none) keeps the stage continuous, so adding this
// signal cannot silently turn a stress run into a phased soak.
export function phaseFor(elapsedS, activeS, idleS) {
  if (!(activeS > 0) || !(idleS > 0)) return "active";
  const windowS = activeS + idleS;
  return elapsedS % windowS < activeS ? "active" : "idle";
}

export function phaseForStage(stage, elapsedS, activeS, idleS) {
  return stage === "soak" ? phaseFor(elapsedS, activeS, idleS) : "active";
}

// §8's Headroom column must be a measurement. /proc/meminfo gives both facts
// directly: MemTotal is the ceiling and MemAvailable the headroom now. Missing
// keys, unreadable files and garbage stay null so the table reports "not
// measured" instead of a zero that would read as a fully idle host.
export function parseMeminfo(text) {
  const read = (key) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*(?:kB)?\\s*$`, "m").exec(text ?? "");
    return match ? Number(match[1]) : null;
  };
  return { memTotalKb: read("MemTotal"), memAvailableKb: read("MemAvailable") };
}

// Cumulative CPU time exactly as `ps` renders it (`cputime`): [[dd-]hh:]mm:ss
// with an optional fractional part. Unparseable input returns null rather than
// 0 — a missing measurement written down as zero would read as a process that
// consumed nothing.
export function cputimeSeconds(text) {
  const match = /^(\d+-)?(\d+:)?(\d+):(\d+)(\.\d+)?$/.exec((text ?? "").trim());
  if (!match) return null;
  const days = match[1] ? Number(match[1].slice(0, -1)) : 0;
  const hours = match[2] ? Number(match[2].slice(0, -1)) : 0;
  const minutes = Number(match[3]);
  const seconds = Number(match[4]) + (match[5] ? Number(match[5]) : 0);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

// GNU df with --output emits one header and one data row. Missing or malformed
// fields stay null so an unavailable measurement can never look like zero use.
export function parseDfOutput(text) {
  const empty = { sizeB: null, usedB: null, availB: null, pcent: null, target: null };
  const lines = String(text ?? "").trim().split(/\r?\n/);
  if (lines.length < 2) return empty;
  const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+?)\s*$/.exec(lines.at(-1));
  if (!row) return empty;
  const sizeB = Number(row[1]);
  const usedB = Number(row[2]);
  const availB = Number(row[3]);
  const target = row[5];
  if (![sizeB, usedB, availB].every(Number.isSafeInteger) || !target) return empty;
  return { sizeB, usedB, availB, pcent: Number(row[4]), target };
}

// `du -sb` prints a byte total followed by the path. Some GNU versions append
// a tab and names may contain spaces, so parse only the leading numeric field.
export function parseDuTotal(text) {
  const match = /^(\d+)\s+.+$/m.exec(String(text ?? "").trim());
  if (!match) return null;
  const bytes = Number(match[1]);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function eventTime(events, key) {
  const value = events?.[key];
  return Number.isFinite(value) ? value : null;
}

export function rollbackTimeline(events, d6Ms) {
  const stop = eventTime(events, "stop");
  const checkout = eventTime(events, "checkout");
  const build = eventTime(events, "build");
  const spawn = eventTime(events, "spawn");
  const boot = eventTime(events, "boot");
  const answer = eventTime(events, "answer");
  const restoreStop = eventTime(events, "restoreStop");
  const restoreBoot = eventTime(events, "restoreBoot");
  const restoreAnswer = eventTime(events, "restoreAnswer");
  const rollbackMs = stop !== null && answer !== null && answer >= stop ? answer - stop : null;
  const answerAfterBoot = boot !== null && answer !== null && answer >= boot;
  const restoreServing = restoreStop !== null && restoreBoot !== null && restoreAnswer !== null &&
    restoreBoot >= restoreStop && restoreAnswer >= restoreBoot;
  return {
    rollbackMs,
    withinD6: rollbackMs !== null && rollbackMs <= d6Ms,
    checkoutMs: stop !== null && checkout !== null && checkout >= stop ? checkout - stop : null,
    buildMs: checkout !== null && build !== null && build >= checkout ? build - checkout : null,
    spawnMs: build !== null && spawn !== null && spawn >= build ? spawn - build : null,
    bootAfterStop: stop !== null && boot !== null && boot >= stop,
    answerAfterBoot,
    restoreMs: restoreStop !== null && restoreAnswer !== null && restoreAnswer >= restoreStop
      ? restoreAnswer - restoreStop
      : null,
    restoreServing,
  };
}

export function qualifiesCiRun(payload, sha) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const matching = runs.filter((run) => run?.head_sha === sha)
    .sort((a, b) => Number(b.run_number ?? 0) - Number(a.run_number ?? 0) ||
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  const run = matching[0];
  const result = {
    qualified: Boolean(run && run.status === "completed" && run.conclusion === "success"),
    runId: run?.id ?? null,
    runNumber: run?.run_number ?? null,
    conclusion: run?.conclusion ?? null,
    headSha: run?.head_sha ?? null,
    reason: !run ? "no ci.yml run for exact head_sha" : run.status !== "completed"
      ? `CI run is ${run.status ?? "not completed"}`
      : run.conclusion === "success" ? "latest ci.yml run succeeded" : `latest CI run conclusion is ${run.conclusion ?? "unknown"}`,
  };
  return result;
}

export function rollbackPreflight({ supplied, rollbackSha, testedSha, resolvable, isAncestor, ci }) {
  let reason = null;
  if (!supplied || !rollbackSha) reason = "rollbackSha not supplied";
  else if (rollbackSha === testedSha) reason = "rollbackSha equals testedSha";
  else if (!resolvable) reason = "rollbackSha is not a resolvable commit";
  else if (!ci?.qualified) reason = ci?.reason ?? "CI qualification unavailable";
  return {
    ok: reason === null,
    reason: reason === null ? "qualified" : `no qualified rollback target: ${reason}`,
    isAncestor: typeof isAncestor === "boolean" ? isAncestor : null,
  };
}

export function parseRollbackScript(logText) {
  const text = String(logText ?? "");
  const marker = /bot-rollback: phase=(?:rollback|restore) sha=([^\s]+) checkout=(\d+) build=(\d+) spawn=(\d+)/.exec(text);
  const exit = /bot-rollback: exit=(\d+)/.exec(text);
  return {
    exit: exit ? Number(exit[1]) : null,
    sha: marker?.[1] ?? null,
    checkout: marker ? Number(marker[2]) : null,
    build: marker ? Number(marker[3]) : null,
    spawn: marker ? Number(marker[4]) : null,
  };
}

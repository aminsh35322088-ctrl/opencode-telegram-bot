#!/usr/bin/env node
// Soak driver: injects raw Telegram updates into the local Bot API stub, waits
// for observable outcomes, enforces the registered deadlines and records
// evidence. A flow that cannot be observed is reported "not-executed", never
// as a pass.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createUpdateBuilders } from "./updates.mjs";
import {
  deleteOutcome,
  draftIssued,
  growthObserved,
  newThreadId,
  outputCalls,
  restartOutcome,
  snapshot,
  stopConfirmed,
  streamCalls,
  topicGone,
} from "./signals.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const STAGE = args.get("stage") ?? "smoke";
const DURATION_S = Number(args.get("duration") ?? 0);
const RUN_DIR = args.get("run-dir");
const UPDATES = args.get("updates");
const RESTART_SCRIPT = args.get("restart-script");
const REPO_DIR = args.get("repo-dir");
const TG_PORT = args.get("telegram-port") ?? "8081";
const TOKEN = args.get("token") ?? "123:soak";
const USER_ID = Number(args.get("user-id") ?? 987654321);
const TG_ROOT = `http://127.0.0.1:${TG_PORT}`;
const MODEL_PORT = args.get("model-port") ?? process.env.SOAK_MODEL_PORT ?? "8090";
const MODEL_ROOT = `http://127.0.0.1:${MODEL_PORT}`;

// Update builders live in their own module so their Telegram shape is under
// test (tests/soak-harness.test.ts); the driver only decides *when* to send.
const { messageUpdate, stopUpdate, callbackUpdate } = createUpdateBuilders({ userId: USER_ID });

// Registered deadlines — docs/SOAK_GATES.md §5. Exceeding one is a failure.
const D = {
  stopConfirmMs: 30_000, // D1 (absolute ceiling)
  lateOutputMs: 2_000, // D2
  stopCleanupMs: 30_000, // D3
  deleteCleanupMs: 60_000, // D4
  restartReadyMs: 120_000, // D5
  topicReusableMs: 10_000, // D7
};

const EVIDENCE = join(RUN_DIR, "evidence");
mkdirSync(EVIDENCE, { recursive: true });
const CYCLE_LOG = join(EVIDENCE, "cycles.jsonl");

let updateId = 1_000_000;
const startedAt = Date.now();

function now() {
  return new Date().toISOString();
}

function record(flow, step, status, detail = {}) {
  const line = { ts: now(), flow, step, status, ...detail };
  appendFileSync(CYCLE_LOG, `${JSON.stringify(line)}\n`);
  const mark = status === "pass" ? "OK  " : status === "fail" ? "FAIL" : "PEND";
  console.log(`${mark} ${flow}/${step}${detail.reason ? ` — ${detail.reason}` : ""}`);
  return line;
}

function enqueue(update) {
  updateId += 1;
  const payload = { update_id: updateId, ...update };
  appendFileSync(UPDATES, `${JSON.stringify(payload)}\n`);
  return payload;
}

async function tgState() {
  const res = await fetch(`${TG_ROOT}/__state`);
  if (!res.ok) throw new Error(`stub state HTTP ${res.status}`);
  return res.json();
}

// The model stub's own counters. `requests` counts every chat completion (the
// Bot's tool-call probe included); `streams` counts streamed completions, which
// only a real prompt produces. `streams` is therefore the honest signal that a
// user turn actually reached a model.
async function modelState() {
  const res = await fetch(`${MODEL_ROOT}/__state`);
  if (!res.ok) throw new Error(`model stub HTTP ${res.status}`);
  return res.json();
}

async function waitForModel(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = { requests: -1, streams: -1 };
  while (Date.now() < deadline) {
    last = await modelState().catch(() => ({ requests: 0, streams: 0 }));
    if (predicate(last)) return { ok: true, value: last };
    await sleep(500);
  }
  return { ok: false, reason: `${label} timed out after ${timeoutMs}ms`, counters: last };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await tgState().catch(() => null);
    if (last) {
      const hit = predicate(last);
      if (hit) return { ok: true, value: hit, state: last };
    }
    await sleep(300);
  }
  return { ok: false, reason: `${label} timed out after ${timeoutMs}ms`, state: last };
}

function readBotPid() {
  const pidFile = join(RUN_DIR, "bot.pid");
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isFinite(pid) ? pid : null;
}

function sampleResources() {
  const pid = readBotPid();
  if (!pid) return { pid: null };
  const out = (cmd, cmdArgs) => {
    try {
      return execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  // Direct-children only is not enough evidence: the Bot's OpenCode server is
  // not always a direct child, which reported childCount=0 while the runtime
  // watchdog saw `childKinds={"opencode-server":1}`. Walk the whole descendant
  // tree so process counts and RSS cover every governed child.
  const parsed = out("ps", ["-eo", "pid=,ppid=,rss=,cmd="])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\s+/);
      return { pid: parts[0], ppid: parts[1], rss: Number(parts[2]) || 0, cmd: parts.slice(3).join(" ") };
    });
  const byParent = new Map();
  for (const row of parsed) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const descendants = [];
  const seen = new Set();
  const stack = [String(pid)];
  while (stack.length > 0) {
    for (const child of byParent.get(stack.pop()) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants.push(child);
      stack.push(child.pid);
    }
  }
  const selfRssKb = Number(out("ps", ["-o", "rss=", "-p", String(pid)])) || 0;
  const childRssKb = descendants.reduce((sum, row) => sum + row.rss, 0);
  return {
    pid,
    selfRssKb,
    childRssKb,
    totalRssKb: selfRssKb + childRssKb,
    childCount: descendants.length,
    children: descendants.map((row) => ({
      pid: Number(row.pid),
      rssKb: row.rss,
      cmd: row.cmd.slice(0, 120),
    })),
    loadavg: out("cat", ["/proc/loadavg"]).split(" ").slice(0, 3).join(" "),
    cpus: Number(out("nproc", [])) || 0,
  };
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

const NEW_CHAT = "\u{1F4AC} New Chat"; // 💬 New Chat — MAIN_BUTTONS.newChat
const DELETE_CHAT = "\u{1F5D1}️ Delete Chat"; // 🗑️ Delete Chat — MAIN_BUTTONS.deleteChat

// W5 presses Stop and W6 presses Delete *while a run is live*, and the stub
// model streams this prompt for ~16 s instead of ~0.4 s, so that precondition
// is owned by the workload rather than won by a race. Keep the wording in sync
// with stub-model.mjs's LONG_PROMPT_PATTERN.
const LONG_PROMPT = "Write a long explanation of the repository layout.";

// The stub exposes `messages` as {messageId: text} and `threads` as
// {name: threadId}; these helpers give the driver a count / ordered ids.
const msgCount = (s) => Object.keys(s?.messages ?? {}).length;

async function flowStart() {
  const base = snapshot(await tgState().catch(() => ({})));
  enqueue(messageUpdate("/start"));
  const r = await waitFor((s) => growthObserved(s, base), 45_000, "reply to /start");
  if (!r.ok) return record("W0", "start", "fail", { reason: r.reason });
  return record("W0", "start", "pass", { replies: msgCount(r.state) });
}

async function flowNewChat() {
  // The thread is what New Chat actually creates, so a *newly created* thread
  // is the only admissible proof that one exists. The Bot takes seconds to
  // create the workspace, session and binding and sends other messages first,
  // so a wait that accepted any growth let the driver read the previous
  // cycle's *deleted* Topic as the newest one and prompt it: the Bot refused
  // it as stale metadata and W2, W5 and W6 went down with it (stress run
  // 38370753677, 2 of 167 cycles). The baseline is captured fresh — earlier
  // cycles leave messages and threads behind, so an absolute count would pass
  // vacuously from the second cycle on.
  const pre = await tgState().catch(() => ({}));
  const base = snapshot(pre);
  enqueue(messageUpdate(NEW_CHAT));
  const r = await waitFor((s) => newThreadId(s, base), 60_000, "new topic id");
  if (!r.ok) return record("W1", "new-chat", "fail", { reason: r.reason });
  record("W1", "new-chat", "pass", { threadId: r.value });
  return { threadId: r.value };
}

async function flowPrompt(threadId) {
  const base = snapshot(await tgState().catch(() => ({})));
  const modelBefore = await modelState().catch(() => ({ requests: 0, streams: 0 }));
  enqueue(messageUpdate("Reply with the single word PONG and then read README.md", { threadId }));
  const r = await waitFor((s) => growthObserved(s, base), 90_000, "streamed reply");
  if (!r.ok) return record("W2", "prompt-stream-tool", "fail", { reason: r.reason });

  // A Telegram-side reply is NOT proof the model ran. An orphaned `opencode
  // serve` left behind by an earlier run answers on the shared port, produces
  // an empty stream, and yields a new Telegram message — which passed here
  // once. Require the model stub to have served a streamed completion after
  // this prompt was sent.
  const model = await waitForModel(
    (c) => c.streams > Number(modelBefore.streams ?? 0),
    45_000,
    "streamed model completion",
  );
  if (!model.ok) {
    return record("W2", "prompt-stream-tool", "fail", {
      reason: `telegram replied but no streamed model completion arrived: ${model.reason}`,
      counters: model.counters,
    });
  }
  return record("W2", "prompt-stream-tool", "pass", {
    drafts: r.state.drafts?.length ?? 0,
    messages: msgCount(r.state),
    modelRequests: model.value.requests,
    modelStreams: model.value.streams,
    modelToolCalls: model.value.toolCalls ?? 0,
  });
}

async function flowStop(threadId) {
  // Stop must cancel a LIVE generation. W2's prompt finishes in about a second,
  // so waiting for a draft that already exists left W5 permanently
  // not-executed. Start a fresh long-running turn and stop it mid-flight.
  const pre = await tgState().catch(() => ({}));
  const base = snapshot(pre);
  enqueue(messageUpdate(LONG_PROMPT, { threadId }));

  // The Bot registers the draft (attributing it to the current run) before it
  // sends it, so the stub having recorded a *new* draft is the proof that a
  // Stop will resolve. Waiting on a published message instead fired before the
  // run had streamed anything: cycle run 38368783928 pressed Stop on the id of
  // an unrelated finished message and the Bot refused it as `unknown-draft`.
  const started = await waitFor(
    (s) => draftIssued(s, base),
    30_000,
    "issued generation draft",
  );
  if (!started.ok) return record("W5", "stop", "not-executed", { reason: started.reason });

  const recordedDraft = (started.state.drafts ?? []).at(-1);
  const draftId = recordedDraft?.draft_id ?? null;
  if (draftId == null) return record("W5", "stop", "not-executed", { reason: "no draft_id recorded" });
  const confirmBase = snapshot(started.state);
  const outputsBefore = outputCalls(started.state);

  const t0 = Date.now();
  enqueue(stopUpdate(threadId ?? draftId, draftId));

  // Confirmation is only ever *observed*, never inferred from the absence of
  // traffic: the Bot's own attribution line for this exact draft. A message
  // published after the press would be equally consistent with the run having
  // finished on its own, so it confirms nothing. A refusal (stale-draft,
  // unknown-draft, …) fails the flow immediately, with the reason the Bot gave.
  let confirmed = { confirmed: false, by: null, refusal: null };
  let confirmState = started.state;
  const deadline = Date.now() + D.stopConfirmMs;
  while (Date.now() < deadline && !confirmed.confirmed) {
    confirmState = (await tgState().catch(() => null)) ?? confirmState;
    confirmed = stopConfirmed(confirmState, confirmBase, readBotLogTail(), draftId);
    if (!confirmed.confirmed && !confirmed.refusal) await sleep(300);
  }
  const confirmMs = Date.now() - t0;
  if (confirmed.refusal) {
    return record("W5", "stop", "fail", {
      reason: `Stop refused by the Bot: ${confirmed.refusal}`,
      confirmMs,
      draftId,
      source: "stub-draft",
      outputsBefore,
    });
  }
  if (!confirmed.confirmed) {
    return record("W5", "stop", "fail", {
      reason: `Stop confirmation timed out after ${D.stopConfirmMs}ms`,
      confirmMs,
      draftId,
      source: "stub-draft",
      outputsBefore,
    });
  }

  // D2: streaming output from the stopped run must cease. Publishing the
  // stopped draft as a final message is the confirmation itself, so only
  // draft/edit calls count as late output.
  const stateAtConfirm = await tgState().catch(() => ({}));
  const outputsAtConfirm = outputCalls(stateAtConfirm);
  const streamsAtConfirm = streamCalls(stateAtConfirm);
  await sleep(D.lateOutputMs + 2_000);
  const after = await tgState();
  const lateDelta = streamCalls(after) - streamsAtConfirm;
  const status = lateDelta > 0 ? "fail" : "pass";
  return record("W5", "stop", status, {
    draftId,
    source: "stub-draft",
    confirmMs,
    confirmedBy: confirmed.by,
    outputsBefore,
    outputsAtConfirm,
    lateDelta,
    streamCalls: streamCalls(after),
    withinD1: confirmMs <= D.stopConfirmMs,
    withinD2: lateDelta === 0,
  });
}

function latestMessageId(state) {
  const ids = Object.keys(state?.messages ?? {}).map(Number).filter(Number.isFinite);
  return ids.length > 0 ? Math.max(...ids) : null;
}

// Tail of the Bot's own log. The Stop contract is confirmed there exactly as
// the Bot reports it (`result=confirmed`), which is the only signal available
// when a cancelled generation publishes no further message. Only the tail is
// read: a stress run grows this file without bound.
function readBotLogTail(maxBytes = 512 * 1024) {
  const logPath = join(RUN_DIR, "bot.log");
  if (!existsSync(logPath)) return "";
  const fd = openSync(logPath, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

// Checkpoint for attributing a restart. Every boot writes the same line, so
// only bytes written after a checkpoint taken before the restart can be that
// restart's boot; the first boot wrote its own copy at the start of the file.
function botLogSize() {
  const logPath = join(RUN_DIR, "bot.log");
  if (!existsSync(logPath)) return 0;
  const fd = openSync(logPath, "r");
  try {
    return fstatSync(fd).size;
  } catch {
    return 0;
  } finally {
    closeSync(fd);
  }
}

function botLogSince(offset) {
  const logPath = join(RUN_DIR, "bot.log");
  if (!existsSync(logPath)) return "";
  const fd = openSync(logPath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return "";
    // The boot line is the first thing the new Bot writes, so the head of the
    // appended region is enough — later growth is not read back.
    const length = Math.min(size - offset, 64 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

async function flowDeleteChat(threadId) {
  // W6 is registered as "Delete a Chat while its run is active … then create a
  // new Topic and assert it is served by the same Worker and works normally".
  // Deleting an idle Topic — what this flow did — cannot exercise the
  // cancel-then-cleanup path at all, so it is not the registered workload.
  const pre = await tgState().catch(() => ({}));
  const base = snapshot(pre);
  enqueue(messageUpdate(LONG_PROMPT, { threadId }));
  const live = await waitFor((s) => draftIssued(s, base), 30_000, "issued generation draft");
  if (!live.ok) return record("W6", "delete-chat", "not-executed", { reason: live.reason });
  const liveDraft = (live.state.drafts ?? []).at(-1)?.draft_id ?? null;

  const beforeCount = msgCount(live.state);
  enqueue(messageUpdate(DELETE_CHAT, { threadId }));

  // Delete Chat does not delete anything on its own: the Bot answers with an
  // inline confirmation (`telegram-topic:delete:confirm`) and only then runs
  // the cleanup. Waiting straight for a deletion timed out after 60 s for a
  // deletion that had never been requested.
  const confirm = await waitFor((s) => msgCount(s) > beforeCount, 30_000, "delete confirmation prompt");
  if (!confirm.ok) return record("W6", "delete-chat", "fail", { reason: confirm.reason, liveDraft });

  const confirmationId = latestMessageId(confirm.state);
  enqueue(callbackUpdate("telegram-topic:delete:confirm", confirmationId, threadId));

  // Cleanup is asserted from two directions: the Bot's own record — it must
  // report deleting a Topic that had an active run, must report completion, and
  // must never have stopped at a retry-safe boundary — and the topic actually
  // disappearing from the Telegram side. An answered callback is not evidence.
  const t0 = Date.now();
  let outcome = { requested: false, completed: false, interrupted: false };
  let gone = false;
  const deadline = Date.now() + D.deleteCleanupMs;
  while (Date.now() < deadline && !(outcome.completed && gone)) {
    const s = (await tgState().catch(() => null)) ?? {};
    outcome = deleteOutcome(readBotLogTail(), threadId);
    gone = topicGone(s, threadId);
    if (!(outcome.completed && gone)) await sleep(300);
  }
  const elapsed = Date.now() - t0;
  if (!outcome.requested) {
    return record("W6", "delete-chat", "fail", {
      reason: "the Bot did not report deleting a Topic with an active run",
      elapsed,
      confirmationId,
      liveDraft,
      topicGone: gone,
      ...outcome,
    });
  }
  if (!outcome.completed || outcome.interrupted || !gone) {
    return record("W6", "delete-chat", "fail", {
      reason: `cleanup not fully observed within ${D.deleteCleanupMs}ms`,
      elapsed,
      confirmationId,
      liveDraft,
      topicGone: gone,
      ...outcome,
    });
  }

  // The run that was in flight must stop producing output once the delete has
  // cancelled it: the Bot cancels the run before the destructive cleanup starts.
  const streamsAtCleanup = streamCalls(await tgState().catch(() => ({})));
  await sleep(D.lateOutputMs + 2_000);
  const lateStreams = streamCalls(await tgState()) - streamsAtCleanup;

  // Same Worker: with one Bot process this is trivially the same worker; what
  // has to be proven is that it still serves a Topic created *after* the
  // delete, and that this Topic is genuinely new — the stub reuses an id for a
  // reused topic name, so a reused id would mean a stale binding was revived.
  const reuseBase = snapshot(await tgState());
  enqueue(messageUpdate(NEW_CHAT));
  const created = await waitFor((s) => newThreadId(s, reuseBase), 30_000, "topic after delete");
  const reuseThreadId = created.ok ? created.value : null;
  if (!reuseThreadId || reuseThreadId === threadId) {
    return record("W6", "delete-chat", "fail", {
      reason: reuseThreadId
        ? "the deleted Topic was reused instead of recreated"
        : "no Topic was created after the delete",
      elapsed,
      confirmationId,
      liveDraft,
      lateStreams,
      reuseThreadId,
      ...outcome,
    });
  }

  const answerBase = snapshot(await tgState());
  const t1 = Date.now();
  enqueue(
    messageUpdate("Reply with the single word PONG and then read README.md", { threadId: reuseThreadId }),
  );
  const answered = await waitFor((s) => growthObserved(s, answerBase), 60_000, "reply in the recreated Topic");
  const reuseMs = Date.now() - t1;
  if (!answered.ok) {
    return record("W6", "delete-chat", "fail", {
      reason: `the recreated Topic did not answer: ${answered.reason}`,
      elapsed,
      confirmationId,
      liveDraft,
      lateStreams,
      reuseThreadId,
      ...outcome,
    });
  }

  return record("W6", "delete-chat", lateStreams > 0 ? "fail" : "pass", {
    elapsed,
    withinD4: elapsed <= D.deleteCleanupMs,
    confirmationId,
    liveDraft,
    deletedTopic: threadId,
    reuseThreadId,
    reuseMs,
    lateStreams,
    requested: outcome.requested,
    completed: outcome.completed,
  });
}

async function flowRestart(threadId) {
  // W7/G7: one controlled restart of the environment. The Bot is stopped and
  // started again from the environment run.sh materialised, and nothing is
  // reseeded — whatever survives was persisted by the Bot itself. It runs while
  // the Topic still exists, so "the same Topic is served afterwards" is checked
  // rather than asserted.
  if (!RESTART_SCRIPT || !REPO_DIR) {
    return record("W7", "restart", "not-executed", {
      reason: "harness was not given --restart-script/--repo-dir",
    });
  }

  const beforePid = readBotPid();
  const logOffset = botLogSize();
  const t0 = Date.now();
  try {
    execFileSync("bash", [RESTART_SCRIPT, RUN_DIR, REPO_DIR], { stdio: "pipe" });
  } catch (error) {
    return record("W7", "restart", "fail", {
      reason: `restart command failed: ${String(error?.stderr ?? error?.message ?? error).slice(0, 300)}`,
      beforePid,
    });
  }

  // The new Bot announces itself before it touches Telegram. Until that line,
  // every byte in the stub state belongs to the process that was just stopped
  // finishing its run: run 38372649512 judged the environment "ready" from
  // exactly that — readyMs=13029 resolved at 10:41:20.83 while the new Bot's
  // first log line is 10:41:21.109, so D5 was satisfied by a Bot that had not
  // booted yet.
  const bootDeadline = Date.now() + D.restartReadyMs;
  let bootMs = null;
  while (bootMs === null && Date.now() < bootDeadline) {
    if (botLogSince(logOffset).includes("Starting OpenCode Telegram Bot")) {
      bootMs = Date.now();
    } else {
      await sleep(200);
    }
  }
  if (bootMs === null) {
    return record("W7", "restart", "fail", {
      reason: `the new Bot never wrote its boot line within D5 (${D.restartReadyMs}ms)`,
      beforePid,
      afterPid: readBotPid(),
      readyMs: Date.now() - t0,
    });
  }

  // D5 measures restart -> environment ready and answering, so the clock runs
  // from the stop through the first answer, not merely through the spawn.
  const base = snapshot(await tgState().catch(() => ({})));
  enqueue(messageUpdate("/start"));
  // The answer is not waited for past the deadline it is measured against.
  const answerBudgetMs = Math.max(0, t0 + D.restartReadyMs - Date.now());
  const answered = await waitFor((s) => growthObserved(s, base), answerBudgetMs, "answer after restart");
  const answerAt = Date.now();
  const readyMs = answerAt - t0;
  const afterPid = readBotPid();
  const outcome = restartOutcome({
    base,
    state: answered.ok ? answered.state : (await tgState().catch(() => ({}))),
    beforePid,
    afterPid,
    elapsedMs: readyMs,
    limitMs: D.restartReadyMs,
    bootMs,
    answerMs: answered.ok ? answerAt : Number.NaN,
  });
  if (!outcome.pass) {
    return record("W7", "restart", "fail", {
      ...outcome,
      reason: !outcome.answered
        ? `no answer within D5 (${D.restartReadyMs}ms)`
        : !outcome.pidChanged
          ? `pid did not change (${beforePid} -> ${afterPid}): the Bot was never stopped`
          : !outcome.answeredAfterBoot
            ? "growth was observed before the new Bot's own boot line: the answer came from the process that was just stopped"
            : `restart exceeded D5 (${readyMs}ms > ${D.restartReadyMs}ms)`,
      beforePid,
      afterPid,
      readyMs,
      bootMs,
    });
  }

  // The environment is only "back" if the Topic that existed before the restart
  // is still served. A Bot that returns without its bindings answers /start and
  // looks healthy while every existing Topic is dead.
  if (threadId) {
    const reuseBase = snapshot(await tgState());
    enqueue(messageUpdate("Reply with the single word PONG and then read README.md", { threadId }));
    const served = await waitFor((s) => growthObserved(s, reuseBase), 60_000, "existing Topic after restart");
    if (!served.ok) {
      return record("W7", "restart", "fail", {
        ...outcome,
        reason: "the Topic that existed before the restart was not served afterwards",
        beforePid,
        afterPid,
        readyMs,
        threadId,
      });
    }
  }

  return record("W7", "restart", "pass", { ...outcome, beforePid, afterPid, readyMs, threadId });
}

async function cycle(index) {
  const resources = [sampleResources()];
  const results = [];
  results.push(await flowStart());
  const chat = await flowNewChat();
  const threadId = chat?.threadId ?? null;
  if (threadId) results.push(await flowPrompt(threadId));
  // W7/G7: a controlled restart — every run of the single-cycle stage, and every
  // tenth cycle under stress — deliberately while the Topic still exists.
  if (STAGE === "cycle" || index % 10 === 0) results.push(await flowRestart(threadId));
  results.push(await flowStop(threadId));
  results.push(await flowDeleteChat(threadId));
  resources.push(sampleResources());

  const failed = results.filter((r) => r.status === "fail");
  const summary = {
    cycle: index,
    ts: now(),
    results,
    resources,
    failed: failed.length,
  };
  appendFileSync(join(EVIDENCE, "resource-samples.jsonl"), `${JSON.stringify({ ts: now(), cycle: index, samples: resources })}\n`);
  return summary;
}

async function main() {
  console.log(`stage=${STAGE} duration=${DURATION_S}s runDir=${RUN_DIR}`);
  const summaries = [];

  if (STAGE === "smoke") {
    const r = await flowStart();
    await flowNewChat();
    summaries.push(r);
    const state = await tgState().catch(() => null);
    writeFileSync(join(EVIDENCE, "smoke-state.json"), JSON.stringify(state, null, 2));
  } else if (STAGE === "cycle") {
    summaries.push(await cycle(1));
  } else if (STAGE === "stress") {
    const deadline = Date.now() + DURATION_S * 1000;
    let i = 0;
    while (Date.now() < deadline) {
      i += 1;
      const summary = await cycle(i);
      summaries.push(summary);
      // Active/idle phasing: keep the active phase dense, then a short idle gap.
      const idle = i % 3 === 0;
      await sleep(idle ? 15_000 : 3_000);
    }
  } else {
    console.error(`unknown stage: ${STAGE}`);
    process.exit(2);
  }

  const counts = { pass: 0, fail: 0, "not-executed": 0 };
  for (const s of summaries) {
    const list = s.results ?? [s];
    for (const r of list) counts[r.status] = (counts[r.status] ?? 0) + 1;
  }
  const out = {
    stage: STAGE,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: now(),
    elapsedS: Math.round((Date.now() - startedAt) / 1000),
    counts,
    cycles: summaries.length,
    resources: sampleResources(),
  };
  writeFileSync(join(EVIDENCE, "summary.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  // Exit non-zero only on an observed failure; unexecuted flows stay pending.
  process.exit(counts.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});

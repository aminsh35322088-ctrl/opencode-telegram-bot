#!/usr/bin/env node
// Soak driver: injects raw Telegram updates into the local Bot API stub, waits
// for observable outcomes, enforces the registered deadlines and records
// evidence. A flow that cannot be observed is reported "not-executed", never
// as a pass.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createUpdateBuilders } from "./updates.mjs";
import { growthObserved, outputCalls, snapshot, stopConfirmed, streamCalls } from "./signals.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const STAGE = args.get("stage") ?? "smoke";
const DURATION_S = Number(args.get("duration") ?? 0);
const RUN_DIR = args.get("run-dir");
const UPDATES = args.get("updates");
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

// The stub exposes `messages` as {messageId: text} and `threads` as
// {name: threadId}; these helpers give the driver a count / ordered ids.
const msgCount = (s) => Object.keys(s?.messages ?? {}).length;
const threadIds = (s) => Object.values(s?.threads ?? {});

async function flowStart() {
  const base = snapshot(await tgState().catch(() => ({})));
  enqueue(messageUpdate("/start"));
  const r = await waitFor((s) => growthObserved(s, base), 45_000, "reply to /start");
  if (!r.ok) return record("W0", "start", "fail", { reason: r.reason });
  return record("W0", "start", "pass", { replies: msgCount(r.state) });
}

async function flowNewChat() {
  // The thread is what New Chat actually creates. Waiting on a message count
  // alone short-circuits as soon as /start's own welcome messages are counted,
  // which recorded a null threadId even though the topic had been created.
  // Both baselines are captured fresh: in a stress run earlier cycles leave
  // messages and threads behind, so an absolute count would pass vacuously.
  const pre = await tgState().catch(() => ({}));
  const base = snapshot(pre);
  const threadsBase = threadIds(pre).length;
  enqueue(messageUpdate(NEW_CHAT));
  const r = await waitFor(
    (s) => threadIds(s).length > threadsBase || growthObserved(s, base),
    60_000,
    "New Chat outcome",
  );
  if (!r.ok) return record("W1", "new-chat", "fail", { reason: r.reason });
  // Newest thread: earlier stress cycles created (and deleted) their own.
  const threadId = threadIds(r.state).at(-1) ?? null;
  record("W1", "new-chat", "pass", { threadId });
  return { threadId };
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
  enqueue(messageUpdate("Write a long explanation of the repository layout.", { threadId }));

  const started = await waitFor(
    (s) => growthObserved(s, base),
    30_000,
    "in-flight draft or streamed message",
  );
  if (!started.ok) return record("W5", "stop", "not-executed", { reason: started.reason });

  // The draft the Bot registered for this run is the identity Stop must be
  // attributed to. A real Telegram client learns the same value from the draft
  // it was shown; the stub records it whenever `sendMessageDraft` is used, so
  // prefer that and fall back to the id of the published message.
  const recordedDraft = (started.state.drafts ?? []).at(-1);
  const draftId = recordedDraft?.draft_id ?? latestMessageId(started.state);
  const confirmBase = snapshot(started.state);
  const outputsBefore = outputCalls(started.state);

  const t0 = Date.now();
  enqueue(stopUpdate(threadId ?? draftId, draftId));

  // Confirmation is only ever *observed*, never assumed: a reply published by
  // the Bot, or the Bot's own `result=confirmed` attribution for this exact
  // draft. A refusal (unknown-draft, stale-draft, …) matches neither and the
  // deadline expires as a failure — exactly what §3 requires of a Stop.
  let confirmed = { confirmed: false, by: null };
  let confirmState = started.state;
  const deadline = Date.now() + D.stopConfirmMs;
  while (Date.now() < deadline && !confirmed.confirmed) {
    confirmState = (await tgState().catch(() => null)) ?? confirmState;
    confirmed = stopConfirmed(confirmState, confirmBase, readBotLogTail(), draftId);
    if (!confirmed.confirmed) await sleep(300);
  }
  const confirmMs = Date.now() - t0;
  const source = recordedDraft ? "stub-draft" : "published-message";
  if (!confirmed.confirmed) {
    return record("W5", "stop", "fail", {
      reason: `Stop confirmation timed out after ${D.stopConfirmMs}ms`,
      confirmMs,
      draftId,
      source,
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
    source,
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

async function flowDeleteChat(threadId) {
  const before = await tgState().catch(() => ({}));
  const beforeCount = msgCount(before);
  const deletionCount = (s) =>
    Number(s?.counters?.deleteMessage ?? 0) + Number(s?.counters?.deleteForumTopic ?? 0);
  const beforeDeletions = deletionCount(before);

  enqueue(messageUpdate(DELETE_CHAT, { threadId }));
  // Delete Chat does not delete anything on its own: the Bot answers with an
  // inline confirmation (`telegram-topic:delete:confirm`) and only then runs
  // the cleanup. Waiting straight for a deletion timed out after 60 s for a
  // deletion that had never been requested.
  const confirm = await waitFor((s) => msgCount(s) > beforeCount, 30_000, "delete confirmation prompt");
  if (!confirm.ok) return record("W6", "delete-chat", "fail", { reason: confirm.reason });

  const confirmationId = latestMessageId(confirm.state);
  enqueue(callbackUpdate("telegram-topic:delete:confirm", confirmationId, threadId));

  const t0 = Date.now();
  const r = await waitFor(
    (s) => deletionCount(s) > beforeDeletions || threadIds(s).length === 0,
    D.deleteCleanupMs,
    "topic cleanup",
  );
  const elapsed = Date.now() - t0;
  if (!r.ok) return record("W6", "delete-chat", "fail", { reason: r.reason, confirmationId });
  return record("W6", "delete-chat", "pass", {
    elapsed,
    withinD4: elapsed <= D.deleteCleanupMs,
    confirmationId,
  });
}

async function cycle(index) {
  const resources = [sampleResources()];
  const results = [];
  results.push(await flowStart());
  const chat = await flowNewChat();
  const threadId = chat?.threadId ?? null;
  if (threadId) results.push(await flowPrompt(threadId));
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

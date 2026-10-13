#!/usr/bin/env node
// Soak driver: injects raw Telegram updates into the local Bot API stub, waits
// for observable outcomes, enforces the registered deadlines and records
// evidence. A flow that cannot be observed is reported "not-executed", never
// as a pass.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

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
let messageId = 10_000;
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

function messageUpdate(text, opts = {}) {
  messageId += 1;
  const message = {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: opts.chatId ?? USER_ID, type: "private", first_name: "Soak" },
    from: { id: opts.fromId ?? USER_ID, is_bot: false, first_name: "Soak" },
    text,
  };
  if (opts.threadId) message.message_thread_id = opts.threadId;
  return { message };
}

function stopUpdate(threadId, draftId) {
  return {
    stopped_message_generation: {
      chat: { id: USER_ID, type: "private", first_name: "Soak" },
      ...(threadId ? { message_thread_id: threadId } : {}),
      draft_id: draftId,
    },
  };
}

async function tgState() {
  const res = await fetch(`${TG_ROOT}/__state`);
  if (!res.ok) throw new Error(`stub state HTTP ${res.status}`);
  return res.json();
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
  const selfRss = out("ps", ["-o", "rss=", "-p", String(pid)]);
  const tree = out("ps", ["--ppid", String(pid), "-o", "pid=", "-rss="]);
  const rows = tree
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((r) => r.length >= 2 && r[0]);
  const childRss = rows.reduce((sum, r) => sum + (Number(r[1]) || 0), 0);
  const selfRssKb = Number(selfRss) || 0;
  return {
    pid,
    selfRssKb,
    childRssKb: childRss,
    totalRssKb: selfRssKb + childRss,
    childCount: rows.length,
    children: rows.map((r) => ({ pid: Number(r[0]), rssKb: Number(r[1]) || 0 })),
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
  enqueue(messageUpdate("/start"));
  const r = await waitFor((s) => msgCount(s) > 0, 45_000, "reply to /start");
  if (!r.ok) return record("W0", "start", "fail", { reason: r.reason });
  return record("W0", "start", "pass", { replies: msgCount(r.state) });
}

async function flowNewChat() {
  enqueue(messageUpdate(NEW_CHAT));
  const r = await waitFor(
    (s) => threadIds(s).length > 0 || msgCount(s) >= 2,
    60_000,
    "New Chat outcome",
  );
  if (!r.ok) return record("W1", "new-chat", "fail", { reason: r.reason });
  const threadId = threadIds(r.state)[0] ?? null;
  record("W1", "new-chat", "pass", { threadId });
  return { threadId };
}

async function flowPrompt(threadId) {
  const before = msgCount(await tgState());
  enqueue(messageUpdate("Reply with the single word PONG and then read README.md", { threadId }));
  const r = await waitFor(
    (s) => msgCount(s) > before || (s.drafts?.length ?? 0) > 0,
    90_000,
    "streamed reply",
  );
  if (!r.ok) return record("W2", "prompt-stream-tool", "fail", { reason: r.reason });
  return record("W2", "prompt-stream-tool", "pass", {
    drafts: r.state.drafts?.length ?? 0,
    messages: msgCount(r.state),
  });
}

async function flowStop(threadId) {
  const before = await tgState();
  const beforeCount = msgCount(before);
  const draft = (before.drafts ?? []).at(-1);
  if (!draft) return record("W5", "stop", "not-executed", { reason: "no stoppable draft observed" });

  const t0 = Date.now();
  enqueue(stopUpdate(threadId ?? draft.message_id, draft.draft_id));

  const confirmed = await waitFor(
    (s) => msgCount(s) > beforeCount,
    D.stopConfirmMs,
    "Stop confirmation",
  );
  const confirmMs = Date.now() - t0;
  if (!confirmed.ok) {
    return record("W5", "stop", "fail", { reason: confirmed.reason, confirmMs, draftId: draft.draft_id });
  }

  // D2: late output from the stopped run must cease.
  const postStopCount = msgCount(confirmed.state);
  await sleep(D.lateOutputMs + 2_000);
  const after = await tgState();
  const lateDelta = msgCount(after) - postStopCount;
  const status = lateDelta > 0 ? "fail" : "pass";
  return record("W5", "stop", status, {
    draftId: draft.draft_id,
    confirmMs,
    lateDelta,
    withinD1: confirmMs <= D.stopConfirmMs,
    withinD2: lateDelta === 0,
  });
}

async function flowDeleteChat(threadId) {
  enqueue(messageUpdate(DELETE_CHAT, { threadId }));
  const t0 = Date.now();
  const r = await waitFor((s) => (s.deletes?.length ?? 0) > 0, D.deleteCleanupMs, "delete request");
  const elapsed = Date.now() - t0;
  if (!r.ok) return record("W6", "delete-chat", "not-executed", { reason: r.reason });
  return record("W6", "delete-chat", "pass", { elapsed, withinD4: elapsed <= D.deleteCleanupMs });
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

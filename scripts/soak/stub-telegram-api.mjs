import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOT_ID = 777000001;
const FIRST_UPDATE_ID = 1000000;
const FIRST_THREAD_ID = 10000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LONG_POLL_TICK_MS = 100;
const MAX_LONG_POLL_SECONDS = 50;
const TOPICS_FILENAME = "forum-topics.json";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      args[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[body] = true;
    } else {
      args[body] = next;
      i += 1;
    }
  }
  return args;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));

const argv = parseArgs(process.argv.slice(2));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.resolve(
  String(argv.log ?? process.env.STUB_TELEGRAM_LOG ?? path.join(scriptDir, "logs", "telegram-api.jsonl")),
);
const logDir = path.dirname(logPath);
const updatesPath = path.resolve(
  String(
    argv.updates ??
      process.env.STUB_TELEGRAM_UPDATES ??
      path.join(logDir, "updates.jsonl"),
  ),
);
const topicsPath = path.join(logDir, TOPICS_FILENAME);
const token = String(argv.token ?? process.env.STUB_TELEGRAM_TOKEN ?? "123:soak");
const port = numberOr(argv.port ?? process.env.STUB_TELEGRAM_PORT, 8081);
const host = String(argv.host ?? process.env.STUB_TELEGRAM_HOST ?? "127.0.0.1");

fs.mkdirSync(logDir, { recursive: true });

const state = {
  threads: new Map(),
  drafts: [],
  messages: new Map(),
  counters: new Map(),
  nextThreadId: FIRST_THREAD_ID,
  nextMessageId: 1,
};

try {
  const saved = JSON.parse(fs.readFileSync(topicsPath, "utf8"));
  state.nextThreadId = numberOr(saved.next, FIRST_THREAD_ID);
  for (const [name, id] of Object.entries(saved.topics ?? {})) {
    state.threads.set(name, numberOr(id, FIRST_THREAD_ID));
  }
} catch {
  // No persisted topic map yet; a corrupt file must not stop the stub from starting.
}
let maxThreadId = FIRST_THREAD_ID - 1;
for (const id of state.threads.values()) maxThreadId = Math.max(maxThreadId, id);
state.nextThreadId = Math.max(state.nextThreadId, maxThreadId + 1);

function persistTopics() {
  try {
    fs.writeFileSync(
      topicsPath,
      `${JSON.stringify(
        { next: state.nextThreadId, topics: Object.fromEntries(state.threads) },
        null,
        2,
      )}\n`,
    );
  } catch (err) {
    console.error(`[stub-telegram-api] cannot persist forum topics: ${err.message}`);
  }
}

let logFd = null;
function logRequest(method, ok, note) {
  try {
    if (logFd === null) logFd = fs.openSync(logPath, "a");
    fs.writeSync(logFd, `${JSON.stringify({ ts: new Date().toISOString(), method, ok, note })}\n`);
  } catch (err) {
    console.error(`[stub-telegram-api] cannot write log: ${err.message}`);
  }
}

// The queue lives in the JSONL file: the driver appends while we run, so we parse only the
// bytes appended since the last poll and never rewrite the file.
const updates = {
  entries: [],
  consumed: 0,
  bytes: 0,
  tail: "",
  lines: 0,
  badLines: 0,
  served: 0,
  nextUpdateId: FIRST_UPDATE_ID,
};

function addUpdateLine(raw) {
  const line = raw.replace(/\r$/, "").trim();
  if (!line) return;
  updates.lines += 1;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    updates.badLines += 1;
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    updates.badLines += 1;
    return;
  }
  // update_id is assigned once per line so repeated polls never renumber an update.
  if (typeof parsed.update_id === "number" && Number.isFinite(parsed.update_id)) {
    updates.nextUpdateId = Math.max(updates.nextUpdateId, parsed.update_id + 1);
  } else {
    parsed.update_id = updates.nextUpdateId++;
  }
  updates.entries.push(parsed);
}

function refreshUpdates() {
  let size;
  try {
    size = fs.statSync(updatesPath).size;
  } catch {
    return;
  }
  if (size < updates.bytes) {
    // Truncated or recreated file: restart parsing from the beginning.
    updates.bytes = 0;
    updates.tail = "";
    updates.entries = [];
    updates.consumed = 0;
  }
  if (size === updates.bytes) return;
  const length = size - updates.bytes;
  const buffer = Buffer.allocUnsafe(length);
  let fd;
  try {
    fd = fs.openSync(updatesPath, "r");
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, updates.bytes + read);
      if (n <= 0) break;
      read += n;
    }
    updates.bytes += read;
    updates.tail += buffer.subarray(0, read).toString("utf8");
  } catch (err) {
    console.error(`[stub-telegram-api] cannot read updates file: ${err.message}`);
    return;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed by the read failure path.
      }
    }
  }
  let index = updates.tail.indexOf("\n");
  while (index >= 0) {
    addUpdateLine(updates.tail.slice(0, index));
    updates.tail = updates.tail.slice(index + 1);
    index = updates.tail.indexOf("\n");
  }
}

function takeBatch(offset, limit) {
  if (Number.isFinite(offset)) {
    while (
      updates.consumed < updates.entries.length &&
      updates.entries[updates.consumed].update_id < offset
    ) {
      updates.consumed += 1;
    }
  }
  const available = updates.entries.length - updates.consumed;
  const count = limit > 0 ? Math.min(limit, available) : available;
  const batch = updates.entries.slice(updates.consumed, updates.consumed + count);
  updates.consumed += count;
  if (updates.consumed > 0 && updates.consumed === updates.entries.length) {
    updates.served += updates.consumed;
    updates.entries = [];
    updates.consumed = 0;
  }
  return batch;
}

async function nextUpdates(params) {
  const offset =
    params.offset === undefined || params.offset === "" ? NaN : numberOr(params.offset, NaN);
  const limit =
    params.limit === undefined || params.limit === ""
      ? 0
      : Math.max(0, Math.trunc(numberOr(params.limit, 0)));
  const timeout = Math.min(Math.max(numberOr(params.timeout, 0), 0), MAX_LONG_POLL_SECONDS);

  refreshUpdates();
  let batch = takeBatch(offset, limit);
  const deadline = Date.now() + timeout * 1000;
  // Long poll: hold the response until an update appears or the requested timeout expires.
  while (batch.length === 0 && Date.now() < deadline) {
    await sleep(Math.min(LONG_POLL_TICK_MS, deadline - Date.now()));
    refreshUpdates();
    batch = takeBatch(offset, limit);
  }
  const note =
    batch.length > 0
      ? `update:${batch[0].update_id}${batch.length > 1 ? `+${batch.length - 1}` : ""}`
      : "update:none";
  return { value: batch, note };
}

const botUser = {
  id: BOT_ID,
  is_bot: true,
  first_name: "SoakBot",
  username: "soak_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  has_topics_enabled: true,
  allows_users_to_create_topics: true,
};

function chatFromRequest(params) {
  if (params.chat && typeof params.chat === "object") return params.chat;
  return { id: numberOr(params.chat_id, 1), type: "private" };
}

function buildMessage(params) {
  const message = {
    message_id: state.nextMessageId++,
    date: Math.floor(Date.now() / 1000),
    chat: chatFromRequest(params),
    text: typeof params.text === "string" ? params.text : "",
  };
  if (params.message_thread_id !== undefined && params.message_thread_id !== null) {
    message.message_thread_id = numberOr(params.message_thread_id, 0);
  }
  if (params.draft_id !== undefined && params.draft_id !== null) {
    message.draft_id = params.draft_id;
  }
  state.messages.set(message.message_id, message.text);
  return message;
}

function draftHandler(method) {
  return (params) => {
    const message = buildMessage(params);
    const draftId = params.draft_id ?? null;
    state.drafts.push({
      chat_id: params.chat_id ?? null,
      draft_id: draftId,
      message_id: message.message_id,
      method,
      received_at: new Date().toISOString(),
    });
    return { value: message, note: `draft:${draftId ?? "none"}` };
  };
}

const handlers = {
  getMe: () => ({ value: botUser }),
  getWebhookInfo: () => ({ value: { url: "" } }),
  deleteWebhook: () => ({ value: true }),
  setMyCommands: () => ({ value: true }),
  logOut: () => ({ value: true }),
  close: () => ({ value: true }),
  createForumTopic: (params) => {
    const name = typeof params.name === "string" ? params.name : String(params.name ?? "");
    // Thread ids are keyed by topic name only: the soak driver uses a single chat and needs
    // the same id for the same name across calls and restarts.
    let id = state.threads.get(name);
    if (id === undefined) {
      id = state.nextThreadId++;
      state.threads.set(name, id);
      persistTopics();
    }
    return { value: { message_thread_id: id, name, icon_color: 13337712 }, note: `topic:${id}` };
  },
  sendMessage: (params) => {
    const message = buildMessage(params);
    return { value: message, note: `msg:${message.message_id}` };
  },
  sendRichMessage: (params) => {
    const message = buildMessage(params);
    return { value: message, note: `msg:${message.message_id}` };
  },
  sendMessageDraft: draftHandler("sendMessageDraft"),
  sendRichMessageDraft: draftHandler("sendRichMessageDraft"),
  editMessageText: (params) => {
    const messageId = numberOr(params.message_id, 0);
    const text = typeof params.text === "string" ? params.text : "";
    if (messageId > 0) state.messages.set(messageId, text);
    return {
      value: {
        message_id: messageId,
        chat: { id: numberOr(params.chat_id, 1) },
        date: Math.floor(Date.now() / 1000),
        text,
      },
      note: `edit:${messageId}`,
    };
  },
  editMessageReplyMarkup: () => ({ value: true }),
  deleteMessage: () => ({ value: true }),
  // Real Telegram deletes the topic and the next one created gets a new id.
  // Without this the stub only counted the attempt, so "cleanup happened" could
  // never be asserted — G4 asks for a resource inventory before/after.
  deleteForumTopic: (params) => {
    const wanted = numberOr(params.message_thread_id, 0);
    let removed = null;
    for (const [name, id] of state.threads) {
      if (id === wanted) {
        removed = name;
        state.threads.delete(name);
        break;
      }
    }
    if (removed !== null) persistTopics();
    return {
      value: true,
      note: removed !== null ? `topic-deleted:${wanted}` : `topic-deleted:${wanted}:absent`,
    }
  },
  answerCallbackQuery: () => ({ value: true }),
  pinChatMessage: () => ({ value: true }),
  unpinAllChatMessages: () => ({ value: true }),
  getFile: () => ({ value: { file_id: "f1", file_unique_id: "u1", file_path: "x.bin" } }),
  getUpdates: (params) => nextUpdates(params),
};

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    let overflow = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (overflow) return;
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        // Oversized payloads degrade to an empty body instead of aborting the connection.
        overflow = true;
        raw = "";
      }
    });
    req.on("end", () => resolve(overflow ? "" : raw));
    req.on("error", () => resolve(overflow ? "" : raw));
  });
}

function parsePayload(raw, contentType) {
  if (!raw) return {};
  // JSON wins whenever the payload looks like JSON: clients disagree about Content-Type, and a
  // soak stub must not silently drop fields because of a missing header.
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (String(contentType ?? "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function snapshot() {
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : port,
    threads: Object.fromEntries(state.threads),
    drafts: state.drafts.slice(),
    messages: Object.fromEntries(state.messages),
    counters: Object.fromEntries(state.counters),
    updates: {
      path: updatesPath,
      pending: updates.entries.length - updates.consumed,
      position: updates.served + updates.consumed,
      lines: updates.lines,
      badLines: updates.badLines,
      nextUpdateId: updates.nextUpdateId,
    },
  };
}

const server = http.createServer(async (req, res) => {
  res.on("error", () => {});
  let url;
  try {
    url = new URL(req.url, "http://stub.local");
  } catch {
    sendJson(res, 400, { ok: false, error_code: 400, description: "Bad Request" });
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (url.pathname === "/__state") {
    sendJson(res, 200, snapshot());
    return;
  }
  if (url.pathname === "/__reset") {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error_code: 405, description: "Method Not Allowed" });
      return;
    }
    await readBody(req);
    // Topic ids and drafts survive a reset so the driver can keep correlating them.
    state.messages.clear();
    state.counters.clear();
    state.nextMessageId = 1;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { ok: false, error_code: 405, description: "Method Not Allowed" });
    return;
  }

  const route = /^\/bot([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
  const raw = await readBody(req);
  if (!route) {
    sendJson(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    return;
  }
  if (decodeComponent(route[1]) !== token) {
    sendJson(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    return;
  }

  const method = decodeComponent(route[2]);
  const params = {
    ...Object.fromEntries(url.searchParams),
    ...parsePayload(raw, req.headers["content-type"]),
  };
  state.counters.set(method, (state.counters.get(method) ?? 0) + 1);

  const handler = handlers[method];
  if (!handler) {
    sendJson(res, 400, { ok: false, error_code: 400, description: "Unsupported method" });
    logRequest(method, false, "unsupported");
    return;
  }
  try {
    const outcome = await handler(params);
    sendJson(res, 200, { ok: true, result: outcome.value });
    logRequest(method, true, outcome.note ?? "");
  } catch (err) {
    const message = String(err?.message ?? err);
    sendJson(res, 500, { ok: false, error_code: 500, description: message });
    logRequest(method, false, `error:${message}`);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[stub-telegram-api] port ${port} is already in use; stop the other process or pass --port`,
    );
    process.exit(1);
  }
  console.error(`[stub-telegram-api] server error: ${err.message}`);
});

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[stub-telegram-api] ${reason} received, shutting down`);
  const finish = () => {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        // Already flushed or closed; exiting must not fail because of it.
      }
      logFd = null;
    }
    process.exit(0);
  };
  server.close(finish);
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  setTimeout(finish, 2000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Windows has no POSIX signals; Ctrl+Break arrives as SIGBREAK and is the only targeted
// console event that can reach this process.
process.on("SIGBREAK", () => shutdown("SIGBREAK"));
process.on("uncaughtException", (err) => {
  console.error(`[stub-telegram-api] uncaughtException: ${err?.stack ?? err}`);
  logRequest("process", false, `uncaught:${String(err?.message ?? "unknown")}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[stub-telegram-api] unhandledRejection: ${reason?.stack ?? reason}`);
  logRequest("process", false, `unhandled:${String(reason?.message ?? reason)}`);
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  console.log(`[stub-telegram-api] listening on http://${host}:${actualPort}`);
  console.log(`[stub-telegram-api] token=${token}`);
  console.log(`[stub-telegram-api] log=${logPath}`);
  console.log(`[stub-telegram-api] updates=${updatesPath}`);
});

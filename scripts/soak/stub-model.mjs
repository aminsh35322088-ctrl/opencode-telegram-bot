import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PIECE_TOKENS = 8;
const MAX_STREAM_MS = 30000;
const DEFAULT_LAST_BODY_CHARS = 4000;
const WORDS = [
  "soak",
  "model",
  "reply",
  "token",
  "stream",
  "chunk",
  "trace",
  "cycle",
  "flush",
  "queue",
  "frame",
  "sample",
  "signal",
  "buffer",
  "packet",
  "bench",
  "state",
  "route",
  "index",
  "value",
];

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const argv = parseArgs(process.argv.slice(2));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.resolve(
  String(argv.log ?? process.env.STUB_MODEL_LOG ?? path.join(scriptDir, "logs", "model-api.jsonl")),
);
const port = numberOr(argv.port ?? process.env.STUB_MODEL_PORT, 8090);
const host = String(argv.host ?? process.env.STUB_MODEL_HOST ?? "127.0.0.1");
const tokenCount = Math.max(1, Math.trunc(numberOr(argv.tokens ?? process.env.STUB_MODEL_TOKENS, 120)));
const delayMs = Math.max(0, numberOr(argv["delay-ms"] ?? process.env.STUB_MODEL_DELAY_MS, 25));
const toolProb = Math.min(1, Math.max(0, numberOr(argv["tool-prob"] ?? process.env.STUB_MODEL_TOOL_PROB, 0.35)));

// 0.35 rounds to 1/3, so every 3rd chat completion carries a tool call. A fixed divisor keeps
// runs reproducible; Math.random() would make soak runs impossible to compare.
const toolCallEvery =
  toolProb <= 0 ? 0 : toolProb >= 1 ? 1 : Math.max(1, Math.round(1 / toolProb));

fs.mkdirSync(path.dirname(logPath), { recursive: true });

const state = {
  requests: 0,
  streams: 0,
  toolCalls: 0,
  lastBody: "",
};

let logFd = null;
function logRequest(entry) {
  try {
    if (logFd === null) logFd = fs.openSync(logPath, "a");
    fs.writeSync(logFd, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    console.error(`[stub-model] cannot write log: ${err.message}`);
  }
}

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

function modelOf(body) {
  return typeof body.model === "string" && body.model ? body.model : "soak-model";
}

function buildText(requestNo, count) {
  const words = [`reply-${requestNo}`];
  while (words.length < count) {
    words.push(WORDS[(words.length * 7 + requestNo * 13) % WORDS.length]);
  }
  return words.slice(0, count).join(" ");
}

function splitPieces(text, size) {
  const words = text.split(/\s+/).filter(Boolean);
  const pieces = [];
  for (let i = 0; i < words.length; i += size) {
    pieces.push(words.slice(i, i + size).join(" "));
  }
  return pieces.length > 0 ? pieces : [text];
}

// The probe endpoint is what the Bot uses to decide whether a model can call tools at all,
// so it must answer with a real tool call and never with streaming.
function isToolProbe(body) {
  if (Array.isArray(body.tools)) {
    for (const entry of body.tools) {
      const name =
        typeof entry?.function?.name === "string"
          ? entry.function.name
          : typeof entry?.name === "string"
            ? entry.name
            : "";
      if (name === "tool_call_probe") return true;
    }
  }
  const choice = body.tool_choice;
  return choice !== undefined && choice !== null && choice !== "auto" && choice !== "none";
}

function probeCompletion(model) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_probe_1",
              type: "function",
              function: { name: "tool_call_probe", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function jsonCompletion(model, text) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: text.split(/\s+/).length, total_tokens: text.split(/\s+/).length + 1 },
  };
}

const TOOL_CALL_CHUNK = {
  index: 0,
  id: "call_1",
  type: "function",
  function: { name: "read_file", arguments: '{"path":"README.md"}' },
};

// W5 and W6 press their control *while the run is live*, and the workload has
// to own that timing instead of racing it: at 120 tokens / 8 per piece / 25 ms
// a run ends in under half a second, so "the run was still active when the
// control arrived" was a coin flip — the very ambiguity that let a refused Stop
// look like a confirmed one. A prompt asking for a long explanation stretches
// to this many milliseconds, and it keeps streaming until something cancels it,
// which is what makes D2 and W6's active-run precondition real: a stream that
// stops after the press is only evidence that the Bot cancelled it.
const LONG_STREAM_TARGET_MS = 16_000;
const LONG_PROMPT_PATTERN = /long explanation/i;

async function streamCompletion(res, model, text, requestNo, longRun = false) {
  const pieces = splitPieces(text, PIECE_TOKENS);
  const emitTool = toolCallEvery > 0 && requestNo % toolCallEvery === 0;
  const toolAt = Math.max(0, Math.floor(pieces.length / 3) - 1);
  // Long delays must still fit the hard 30 s ceiling, so the per-piece delay shrinks first.
  // A long run works the other way round: it stretches the delay so the run is
  // still live when the driver presses Stop or Delete.
  const delay = longRun
    ? Math.max(delayMs, Math.floor(LONG_STREAM_TARGET_MS / (pieces.length + 4)))
    : Math.min(delayMs, Math.floor(MAX_STREAM_MS / (pieces.length + 4)));
  const deadline = Date.now() + MAX_STREAM_MS;
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let emittedTool = false;

  const chunk = (delta, finishReason = null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const write = (payload) => {
    if (res.destroyed || res.writableEnded) return false;
    try {
      res.write(payload);
      return true;
    } catch {
      return false;
    }
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  write(chunk({ role: "assistant" }));

  for (let i = 0; i < pieces.length; i += 1) {
    if (Date.now() >= deadline) break;
    await sleep(delay);
    if (res.destroyed || res.writableEnded) break;
    write(chunk({ content: `${i > 0 ? " " : ""}${pieces[i]}` }));
    if (emitTool && i === toolAt) {
      write(chunk({ tool_calls: [TOOL_CALL_CHUNK] }));
      // OpenAI flushes the arguments as a trailing tool_call delta; a consumer appends these
      // strings, so the final flush must be empty to leave the JSON intact.
      write(
        chunk({
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }],
        }),
      );
      emittedTool = true;
      state.toolCalls += 1;
    }
  }
  // The harness contract asks for finish_reason "stop" even on tool-call turns.
  write(chunk({}, "stop"));
  write("data: [DONE]\n\n");
  if (!res.destroyed && !res.writableEnded) res.end();
  return emittedTool;
}

function logKind(pathname) {
  if (pathname === "/health") return "health";
  if (pathname === "/__reset") return "reset";
  if (pathname === "/v1/models" || pathname === "/models") return "models";
  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") return "chat";
  return pathname;
}

const server = http.createServer(async (req, res) => {
  res.on("error", () => {});
  let url;
  try {
    url = new URL(req.url, "http://stub.local");
  } catch {
    sendJson(res, 400, { error: { message: "Bad Request", type: "invalid_request_error" } });
    return;
  }

  if (url.pathname === "/health") {
    logRequest({ kind: "health", stream: false, toolProbe: false, tokens: 0 });
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (url.pathname === "/__state") {
    sendJson(res, 200, { ...state, lastBody: state.lastBody });
    return;
  }
  if (url.pathname === "/__reset") {
    await readBody(req);
    state.requests = 0;
    state.streams = 0;
    state.toolCalls = 0;
    logRequest({ kind: "reset", stream: false, toolProbe: false, tokens: 0 });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { error: { message: "Method Not Allowed", type: "invalid_request_error" } });
    return;
  }

  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    logRequest({ kind: "models", stream: false, toolProbe: false, tokens: 0 });
    sendJson(res, 200, {
      object: "list",
      data: [{ id: "soak-model", object: "model", created: 1, owned_by: "soak" }],
    });
    return;
  }

  if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
    const raw = await readBody(req);
    const body = parsePayload(raw, req.headers["content-type"]);
    state.requests += 1;
    state.lastBody = raw.slice(0, DEFAULT_LAST_BODY_CHARS);

    const model = modelOf(body);
    const probe = isToolProbe(body);
    const wantsStream = body.stream === true || body.stream === "true";
    const requestNo = state.requests;

    if (probe) {
      logRequest({ kind: "chat", stream: false, toolProbe: true, tokens: 0 });
      sendJson(res, 200, probeCompletion(model));
      return;
    }

    const text = buildText(requestNo, tokenCount);
    if (!wantsStream) {
      logRequest({ kind: "chat", stream: false, toolProbe: false, tokens: tokenCount });
      sendJson(res, 200, jsonCompletion(model, text));
      return;
    }

    const longRun = LONG_PROMPT_PATTERN.test(raw);
    state.streams += 1;
    try {
      const emittedTool = await streamCompletion(res, model, text, requestNo, longRun);
      logRequest({ kind: "chat", stream: true, toolProbe: false, tokens: tokenCount, tool: emittedTool, long: longRun });
    } catch (err) {
      console.error(`[stub-model] stream failed: ${err.message}`);
      logRequest({ kind: "chat", stream: true, toolProbe: false, tokens: tokenCount, tool: false });
      if (!res.destroyed && !res.writableEnded) res.end();
    }
    return;
  }

  if (req.method === "POST") await readBody(req);
  logRequest({ kind: logKind(url.pathname), stream: false, toolProbe: false, tokens: 0 });
  sendJson(res, 404, { error: { message: "Not Found", type: "invalid_request_error" } });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[stub-model] port ${port} is already in use; stop the other process or pass --port`,
    );
    process.exit(1);
  }
  console.error(`[stub-model] server error: ${err.message}`);
});

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[stub-model] ${reason} received, shutting down`);
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
  console.error(`[stub-model] uncaughtException: ${err?.stack ?? err}`);
  logRequest({ kind: "process", stream: false, toolProbe: false, tokens: 0 });
});
process.on("unhandledRejection", (reason) => {
  console.error(`[stub-model] unhandledRejection: ${reason?.stack ?? reason}`);
  logRequest({ kind: "process", stream: false, toolProbe: false, tokens: 0 });
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  console.log(`[stub-model] listening on http://${host}:${actualPort}`);
  console.log(`[stub-model] log=${logPath}`);
  console.log(
    `[stub-model] tokens=${tokenCount} delayMs=${delayMs} toolProb=${toolProb} (tool call every ${toolCallEvery || "never"})`,
  );
});

import { tool } from "@opencode-ai/plugin";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

type SessionState = "idle" | "busy" | "retry" | "not-found" | "unknown";

function apiUrl(): string {
  return (process.env.OPENCODE_API_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");
}

function headers(): Record<string, string> {
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD || "";
  if (!password) return { "Content-Type": "application/json" };
  const credentials = Buffer.from(`${username}:${password}`).toString("base64");
  return { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" };
}

function timeoutSignal(ms: number, parent: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timeout);
    parent.removeEventListener("abort", abort);
  }, { once: true });
  return controller.signal;
}

async function request(path: string, init: RequestInit, parentSignal: AbortSignal): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    signal: timeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS, parentSignal),
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, 2000);
    }
  }
  return { status: response.status, data };
}

function extractStatus(data: unknown, sessionId: string): SessionState {
  if (typeof data !== "object" || data === null) return "unknown";
  const record = data as Record<string, unknown>;
  const direct = record[sessionId];
  if (typeof direct === "object" && direct !== null) {
    const status = (direct as Record<string, unknown>).type;
    if (status === "idle" || status === "busy" || status === "retry") return status;
  }
  if (record.type === "idle" || record.type === "busy" || record.type === "retry") return record.type;
  return "unknown";
}

async function getSessionState(sessionId: string, signal: AbortSignal): Promise<{ status: number; state: SessionState; details: unknown }> {
  const result = await request(`/session/status`, { method: "GET" }, signal);
  if (result.status === 404) return { status: result.status, state: "not-found", details: result.data };
  return { status: result.status, state: extractStatus(result.data, sessionId), details: result.data };
}

async function waitForIdle(sessionId: string, waitMs: number, signal: AbortSignal): Promise<SessionState> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const state = await getSessionState(sessionId, signal);
    if (state.state === "idle" || state.state === "not-found") return state.state;
    if (state.state === "unknown" && state.status >= 400) return state.state;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  return (await getSessionState(sessionId, signal)).state;
}

export default tool({
  description: "Recover a stuck OpenCode session without deleting its history. Inspect status first, abort only a known non-idle session, then optionally continue only after the session is confirmed idle. Use this instead of repeatedly retrying a hung command.",
  args: {
    sessionId: tool.schema.string().describe("OpenCode session ID to inspect or recover."),
    action: tool.schema.enum(["inspect", "abort", "continue"]).describe("Recovery action."),
    prompt: tool.schema.string().optional().describe("Prompt used by continue. Ask the agent to resume from the preserved session state rather than repeating an unsafe side effect."),
  },
  async execute(args, context) {
    try {
      const before = await getSessionState(args.sessionId, context.abort);
      if (before.status >= 500) return `RECOVERY FAILED: OpenCode status endpoint returned HTTP ${before.status}`;

      if (args.action === "inspect") {
        return `SESSION ${args.sessionId}: status=${before.state}`;
      }

      if (args.action === "abort") {
        if (before.state === "idle" || before.state === "not-found") {
          return `NO ACTION: session=${args.sessionId} is already ${before.state}`;
        }
        if (before.state === "unknown") {
          return `RECOVERY FAILED CLOSED: session=${args.sessionId} status is unknown; refusing to abort blindly.`;
        }

        const result = await request(`/session/${encodeURIComponent(args.sessionId)}/abort`, { method: "POST" }, context.abort);
        if (result.status < 200 || result.status >= 300 || result.data === false) {
          return `ABORT FAILED: session=${args.sessionId} http=${result.status}`;
        }
        const finalState = await waitForIdle(args.sessionId, DEFAULT_IDLE_WAIT_MS, context.abort);
        return `ABORTED: session=${args.sessionId} previousStatus=${before.state} finalStatus=${finalState}`;
      }

      if (!args.prompt?.trim()) {
        return `NOT READY: continue requires a recovery prompt. Inspect/abort first when the session is stuck.`;
      }

      const current = await getSessionState(args.sessionId, context.abort);
      if (current.state === "busy" || current.state === "retry") {
        const abortResult = await request(`/session/${encodeURIComponent(args.sessionId)}/abort`, { method: "POST" }, context.abort);
        if (abortResult.status < 200 || abortResult.status >= 300 || abortResult.data === false) {
          return `RECOVERY FAILED: session remained ${current.state}; abort returned HTTP ${abortResult.status}`;
        }
        const afterAbort = await waitForIdle(args.sessionId, DEFAULT_IDLE_WAIT_MS, context.abort);
        if (afterAbort !== "idle") {
          return `RECOVERY FAILED: session did not become idle after abort; status=${afterAbort}`;
        }
      } else if (current.state !== "idle") {
        return `RECOVERY FAILED CLOSED: session=${args.sessionId} is ${current.state}; refusing to continue without a confirmed idle state.`;
      }

      const result = await request(`/session/${encodeURIComponent(args.sessionId)}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({ parts: [{ type: "text", text: args.prompt.trim() }] }),
      }, context.abort);
      if (result.status < 200 || result.status >= 300) {
        return `CONTINUE FAILED: session=${args.sessionId} http=${result.status}`;
      }
      return `RECOVERY CONTINUE ACCEPTED: session=${args.sessionId}. The previous session history was preserved; continue from the current state and avoid repeating side effects already completed.`;
    } catch (error) {
      if (context.abort.aborted) return "ABORTED: recovery operation was cancelled.";
      const message = error instanceof Error ? error.message : String(error);
      return `RECOVERY ERROR: ${message}`;
    }
  },
});

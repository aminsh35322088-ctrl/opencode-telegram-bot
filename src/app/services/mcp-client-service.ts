import { budgetedSpawn } from "../../runtime/process-budget.js";
import type { ManagedMcpConfig } from "./mcp-server-store.js";
import { logger } from "../../utils/logger.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "opencode-telegram-bot", version: "1" };
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<Record<string, unknown>>;
  isError: boolean;
}

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface McpSession {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcErrorMessage(value: JsonRpcResponse["error"], method: string): string {
  const message = typeof value?.message === "string" ? value.message : "unknown error";
  return `MCP ${method} failed: ${message}`;
}

function createIdGenerator(): () => number {
  let next = 1;
  return () => next++;
}

function truncateOutput(value: string): string {
  return value.length > MAX_OUTPUT_BYTES ? `${value.slice(0, MAX_OUTPUT_BYTES)}\n[truncated]` : value;
}

/**
 * Splits a raw stream chunk buffer into complete JSON-RPC messages. MCP stdio
 * framing is newline-delimited, so a trailing partial line stays buffered for
 * the next chunk instead of being parsed as a broken message.
 */
export function extractJsonRpcMessages(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  let rest = buffer;
  while (true) {
    const newline = rest.indexOf("\n");
    if (newline < 0) break;
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Servers may print non-protocol noise on stdout. Skip unparsable lines
      // instead of failing the whole session.
    }
  }
  return { messages, rest };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function openStdioSession(config: Extract<ManagedMcpConfig, { type: "local" }>, timeoutMs: number): Promise<McpSession> {
  if(process.env.DISTRIBUTED_CONTROL_ENABLED==="1")throw new Error("Local MCP processes belong to the Topic Worker.");
  const [command, ...args] = config.command;
  if (!command) throw new Error("MCP local command is required.");

  const child = await budgetedSpawn("mcp-server", command, args, {
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.environment ? { env: { ...process.env, ...config.environment } } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdin || !stdout || !stderr) {
    child.kill("SIGKILL");
    throw new Error("MCP local server could not be started with piped stdio.");
  }

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const nextId = createIdGenerator();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let closed = false;

  const failPending = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > MAX_OUTPUT_BYTES * 4) {
      stdoutBuffer = stdoutBuffer.slice(-MAX_OUTPUT_BYTES * 4);
    }
    const { messages, rest } = extractJsonRpcMessages(stdoutBuffer);
    stdoutBuffer = rest;
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const response = message as JsonRpcResponse;
      if (typeof response.id !== "number") continue;
      const entry = pending.get(response.id);
      if (!entry) continue;
      pending.delete(response.id);
      if (response.error) entry.reject(new Error(rpcErrorMessage(response.error, "request")));
      else entry.resolve(response.result);
    }
  });

  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    stderrBuffer = truncateOutput(stderrBuffer + chunk);
  });

  child.on("error", (error) => {
    closed = true;
    failPending(new Error(`MCP local server could not start: ${error.message}`));
  });

  child.on("close", (code) => {
    closed = true;
    const detail = stderrBuffer.trim() ? `: ${truncateOutput(stderrBuffer).trim()}` : "";
    failPending(new Error(`MCP local server closed (exit code ${code ?? "unknown"})${detail}`));
  });

  const write = (payload: Record<string, unknown>): void => {
    if (closed || stdin.destroyed) throw new Error("MCP local server connection is closed.");
    stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const session: McpSession = {
    request(method, params) {
      const id = nextId();
      return withTimeout(
        new Promise<unknown>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try {
            write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
          } catch (error) {
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
        timeoutMs,
        `MCP ${method}`,
      );
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        stdin.end();
        child.kill();
      });
    },
  };
  return session;
}

function parseSsePayloads(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON SSE payloads.
    }
  }
  return messages;
}

async function postJsonRpc(
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = truncateOutput(await response.text());
  if (!response.ok) {
    throw new Error(`MCP endpoint returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const candidates = contentType.includes("text/event-stream") ? parseSsePayloads(body) : [safeParseJson(body)];
  for (const candidate of candidates) {
    if (isRecord(candidate) && ("result" in candidate || "error" in candidate)) return candidate as JsonRpcResponse;
  }
  throw new Error("MCP endpoint returned no JSON-RPC response.");
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function openRemoteSession(
  config: Extract<ManagedMcpConfig, { type: "remote" }>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<McpSession> {
  const nextId = createIdGenerator();
  const url = config.url;
  const post = (payload: Record<string, unknown>) => postJsonRpc(url, payload, headers, timeoutMs);

  return {
    async request(method, params) {
      const response = await post({
        jsonrpc: "2.0",
        id: nextId(),
        method,
        ...(params ? { params } : {}),
      });
      if (response.error) throw new Error(rpcErrorMessage(response.error, method));
      return response.result;
    },
    async notify(method, params) {
      try {
        await post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
      } catch (error) {
        // Notifications are advisory: a server may answer 202/405. Never let a
        // failed notification break the caller.
        logger.debug("[McpClient] Notification could not be delivered", method, error instanceof Error ? error.message : String(error));
      }
    },
    async close() {
      // Stateless HTTP transport: nothing to tear down per call.
    },
  };
}

function normalizeToolList(value: unknown): McpToolDescriptor[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) return [];
  const tools: McpToolDescriptor[] = [];
  for (const entry of value.tools) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) continue;
    tools.push({
      name: entry.name.trim(),
      ...(typeof entry.title === "string" && entry.title.trim() ? { title: entry.title.trim() } : {}),
      ...(typeof entry.description === "string" && entry.description.trim() ? { description: entry.description.trim() } : {}),
      ...(isRecord(entry.inputSchema) ? { inputSchema: entry.inputSchema } : {}),
    });
  }
  return tools;
}

function normalizeCallResult(value: unknown): McpCallResult {
  if (!isRecord(value)) return { content: [], isError: false };
  const content = Array.isArray(value.content)
    ? value.content.filter(isRecord)
    : [];
  return { content, isError: value.isError === true };
}

export interface McpClientOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function listMcpTools(
  config: ManagedMcpConfig,
  options: McpClientOptions = {},
): Promise<McpToolDescriptor[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const session = config.type === "local"
    ? await openStdioSession(config, timeoutMs)
    : await openRemoteSession(config, options.headers ?? {}, timeoutMs);
  try {
    await session.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    session.notify("notifications/initialized");
    return normalizeToolList(await session.request("tools/list"));
  } finally {
    await session.close();
  }
}

export async function callMcpTool(
  config: ManagedMcpConfig,
  toolName: string,
  args: Record<string, unknown>,
  options: McpClientOptions = {},
): Promise<McpCallResult> {
  if(process.env.DISTRIBUTED_CONTROL_ENABLED==="1")throw new Error("MCP tool execution belongs to the Topic Worker.");
  const name = toolName.trim();
  if (!name) throw new Error("MCP tool name is required.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const session = config.type === "local"
    ? await openStdioSession(config, timeoutMs)
    : await openRemoteSession(config, options.headers ?? {}, timeoutMs);
  try {
    await session.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    session.notify("notifications/initialized");
    return normalizeCallResult(await session.request("tools/call", { name, arguments: args }));
  } finally {
    await session.close();
  }
}

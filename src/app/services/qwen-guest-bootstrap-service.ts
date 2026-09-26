import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket, { type RawData } from "ws";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

interface QwenBaxiaFile {
  "bx-ua": string;
  "bx-umidtoken": string;
  "bx-v": string;
  captured_unix: number;
  verified: boolean;
}

export interface QwenGuestBootstrapResult {
  captured: boolean;
  path: string;
}

const QWEN_URL = "https://chat.qwen.ai";
const BROWSER_START_TIMEOUT_MS = 12_000;
const HEADER_CAPTURE_TIMEOUT_MS = 20_000;
const CDP_COMMAND_TIMEOUT_MS = 8_000;

function qwenDataDir(): string {
  return path.join(getRuntimePaths().appHome, "omnirouter");
}

export function getQwenBxFilePath(): string {
  return path.join(qwenDataDir(), "qwen-bx.json");
}

async function readBaxiaFile(): Promise<QwenBaxiaFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(getQwenBxFilePath(), "utf8")) as Partial<QwenBaxiaFile>;
    if (
      typeof parsed["bx-ua"] !== "string" || !parsed["bx-ua"]
      || typeof parsed["bx-umidtoken"] !== "string" || !parsed["bx-umidtoken"]
      || typeof parsed["bx-v"] !== "string" || !parsed["bx-v"]
    ) return null;
    return {
      "bx-ua": parsed["bx-ua"],
      "bx-umidtoken": parsed["bx-umidtoken"],
      "bx-v": parsed["bx-v"],
      captured_unix: typeof parsed.captured_unix === "number" ? parsed.captured_unix : 0,
      verified: parsed.verified === true,
    };
  } catch {
    return null;
  }
}

export async function isQwenGuestPrepared(requireVerified = true): Promise<boolean> {
  const file = await readBaxiaFile();
  return Boolean(file && (!requireVerified || file.verified));
}

export async function setQwenGuestVerified(verified: boolean): Promise<void> {
  const file = await readBaxiaFile();
  if (!file) return;
  file.verified = verified;
  await fs.writeFile(getQwenBxFilePath(), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(getQwenBxFilePath(), 0o600).catch(() => {});
}

async function findChromiumExecutable(): Promise<string | null> {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (explicit) {
    try { await fs.access(explicit); return explicit; } catch { /* continue */ }
  }

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || "/opt/ms-playwright";
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("chromium_headless_shell-")) {
        candidates.push(path.join(root, entry.name, "chrome-headless-shell-linux64", "headless_shell"));
      }
      if (entry.name.startsWith("chromium-")) {
        candidates.push(
          path.join(root, entry.name, "chrome-linux", "chrome"),
          path.join(root, entry.name, "chrome-linux64", "chrome"),
        );
      }
    }
    candidates.sort().reverse();
    for (const candidate of candidates) {
      try { await fs.access(candidate); return candidate; } catch { /* continue */ }
    }
  } catch {
    // Fall through to common system paths.
  }

  for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    try { await fs.access(candidate); return candidate; } catch { /* continue */ }
  }
  return null;
}

async function waitForDevToolsUrl(child: ChildProcess): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(url!);
    };
    const onData = (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-16_000);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match?.[1]) finish(undefined, match[1]);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Chromium exited before DevTools was ready (code=${code ?? "null"}, signal=${signal ?? "none"})`));
    };
    const timer = setTimeout(() => finish(new Error("Chromium DevTools startup timed out")), BROWSER_START_TIMEOUT_MS);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP WebSocket open timed out")), CDP_COMMAND_TIMEOUT_MS);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

async function captureBaxiaHeaders(devtoolsUrl: string): Promise<QwenBaxiaFile> {
  const ws = new WebSocket(devtoolsUrl);
  await waitForOpen(ws);

  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const requestUrls = new Map<string, string>();
  const extraHeaders = new Map<string, Record<string, unknown>>();
  let capturedResolve: ((value: QwenBaxiaFile) => void) | null = null;
  const capturedPromise = new Promise<QwenBaxiaFile>((resolve) => { capturedResolve = resolve; });

  const maybeCapture = (requestId: string) => {
    const url = requestUrls.get(requestId);
    const headers = extraHeaders.get(requestId);
    if (!url?.includes("/api/v2/") || !headers || !capturedResolve) return;
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const bxUa = normalized["bx-ua"];
    const bxUmid = normalized["bx-umidtoken"];
    const bxV = normalized["bx-v"];
    if (!bxUa || !bxUmid || !bxV) return;
    const resolve = capturedResolve;
    capturedResolve = null;
    resolve({
      "bx-ua": bxUa,
      "bx-umidtoken": bxUmid,
      "bx-v": bxV,
      captured_unix: Math.floor(Date.now() / 1000),
      verified: false,
    });
  };

  const onMessage = (raw: RawData) => {
    let message: CdpMessage;
    try { message = JSON.parse(raw.toString()) as CdpMessage; } catch { return; }
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || "CDP command failed"));
      else waiter.resolve(message.result ?? {});
      return;
    }
    const params = message.params ?? {};
    const requestId = typeof params.requestId === "string" ? params.requestId : "";
    if (message.method === "Network.requestWillBeSent" && requestId) {
      const request = params.request && typeof params.request === "object" ? params.request as Record<string, unknown> : null;
      if (typeof request?.url === "string") requestUrls.set(requestId, request.url);
      maybeCapture(requestId);
    }
    if (message.method === "Network.requestWillBeSentExtraInfo" && requestId) {
      const headers = params.headers && typeof params.headers === "object" ? params.headers as Record<string, unknown> : null;
      if (headers) extraHeaders.set(requestId, headers);
      maybeCapture(requestId);
    }
  };
  ws.on("message", onMessage);

  const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return await response;
  };

  try {
    const target = await send("Target.createTarget", { url: "about:blank" });
    const targetId = typeof target.targetId === "string" ? target.targetId : "";
    if (!targetId) throw new Error("Chromium did not create a target");
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = typeof attached.sessionId === "string" ? attached.sessionId : "";
    if (!sessionId) throw new Error("Chromium did not attach a page session");

    await Promise.all([
      send("Page.enable", {}, sessionId),
      send("Network.enable", {}, sessionId),
      send("Runtime.enable", {}, sessionId),
    ]);
    await send("Network.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      acceptLanguage: "en-US,en;q=0.9",
      platform: "Win32",
    }, sessionId);
    await send("Page.navigate", { url: QWEN_URL }, sessionId);

    let captured = await Promise.race([
      capturedPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 9_000)),
    ]);
    if (!captured) {
      await send("Runtime.evaluate", {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          try {
            const res = await fetch('/api/v2/chats/new', {
              method: 'POST',
              headers: {'Content-Type':'application/json','source':'web','version':'0.2.91','x-request-id':crypto.randomUUID()},
              body: JSON.stringify({title:'New Chat',models:['qwen3.8-max'],chat_mode:'guest',chat_type:'t2t',timestamp:Date.now(),project_id:''})
            });
            return res.status;
          } catch (e) { return -1; }
        })()`,
      }, sessionId).catch(() => ({}));
      captured = await Promise.race([
        capturedPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), HEADER_CAPTURE_TIMEOUT_MS - 9_000)),
      ]);
    }
    if (!captured) throw new Error("Qwen page did not emit Baxia headers");
    return captured;
  } finally {
    ws.off("message", onMessage);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CDP connection closed"));
    }
    pending.clear();
    ws.close();
  }
}

export async function prepareQwenGuestHeaders(): Promise<QwenGuestBootstrapResult> {
  const executable = await findChromiumExecutable();
  if (!executable) throw new Error("No Chromium executable is available for automatic Qwen guest setup");

  const dataDir = qwenDataDir();
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "otb-qwen-"));
  const child = spawn(executable, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: {
      HOME: profileDir,
      TMPDIR: os.tmpdir(),
      LANG: process.env.LANG || "C.UTF-8",
      LC_ALL: process.env.LC_ALL || "C.UTF-8",
    },
  });

  try {
    const devtoolsUrl = await waitForDevToolsUrl(child);
    const captured = await captureBaxiaHeaders(devtoolsUrl);
    const outputPath = getQwenBxFilePath();
    await fs.writeFile(outputPath, JSON.stringify(captured, null, 2) + "\n", { mode: 0o600 });
    await fs.chmod(outputPath, 0o600).catch(() => {});
    logger.info("[FreeModelSources] Qwen guest Baxia headers captured automatically");
    return { captured: true, path: outputPath };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

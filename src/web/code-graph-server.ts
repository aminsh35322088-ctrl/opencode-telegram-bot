import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const UI_HOST = "127.0.0.1";
const UI_PORT = 9749;
const SESSION_COOKIE = "cbm_graph_session";
const SESSION_TTL_SECONDS = 60 * 60;
const MAX_INIT_DATA_BYTES = 16 * 1024;

let uiProcess: ChildProcessWithoutNullStreams | null = null;
let webServer: ReturnType<typeof createServer> | null = null;

function getPublicWebAppUrl(): string | null {
  const configured = process.env.CODE_GRAPH_WEB_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (domain) return `https://${domain}`;
  return null;
}

export function getCodeGraphWebAppUrl(): string | null {
  return getPublicWebAppUrl();
}

function hexHmac(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function validateTelegramInitData(initData: string): number | null {
  if (!initData || Buffer.byteLength(initData, "utf8") > MAX_INIT_DATA_BYTES) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDateRaw = params.get("auth_date");
  const userRaw = params.get("user");
  if (!receivedHash || !authDateRaw || !userRaw) return null;

  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || Math.abs(Math.floor(Date.now() / 1000) - authDate) > SESSION_TTL_SECONDS) return null;

  let userId: number;
  try {
    const user = JSON.parse(userRaw) as { id?: unknown };
    if (typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return null;
    userId = user.id;
  } catch {
    return null;
  }
  if (userId !== config.telegram.allowedUserId) return null;

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(config.telegram.token).digest();
  const expectedHash = hexHmac(secretKey, dataCheckString);
  const expected = Buffer.from(expectedHash, "hex");
  const received = Buffer.from(receivedHash, "hex");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  return userId;
}

function createSessionCookie(userId: number): string {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${userId}.${expires}`;
  const signature = hexHmac(config.telegram.token, `code-graph:${payload}`);
  return `${payload}.${signature}`;
}

function validateSessionCookie(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [userIdRaw, expiresRaw, signature] = parts;
  const userId = Number(userIdRaw);
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(userId) || userId !== config.telegram.allowedUserId) return false;
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(hexHmac(config.telegram.token, `code-graph:${userId}.${expires}`), "hex");
  const received = Buffer.from(signature ?? "", "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function cookieValue(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const [name, ...rest] = entry.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function graphGateHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Code Graph</title>
<style>
html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#09090b;color:#f4f4f5}
body{display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{text-align:center;max-width:420px}
.spinner{width:42px;height:42px;margin:0 auto 18px;border:3px solid #27272a;border-top-color:#fafafa;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:24px;margin:0 0 8px}p{color:#a1a1aa;line-height:1.5;margin:0}
#status{margin-top:14px;font-size:14px}
</style>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>
<main>
<div class="spinner"></div>
<h1>🧠 Code Graph</h1>
<p>Authorizing the Telegram Mini App…</p>
<p id="status"></p>
</main>
<script>
(() => {
  const tg = window.Telegram?.WebApp;
  if (!tg) { document.getElementById('status').textContent = 'Open this page from the Telegram bot.'; return; }
  tg.ready();
  tg.expand();
  fetch('/__code-graph/auth', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({initData: tg.initData || ''})
  }).then(async (response) => {
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Authorization failed');
    window.location.replace('/');
  }).catch((error) => {
    document.querySelector('.spinner').style.display = 'none';
    document.getElementById('status').textContent = error.message;
  });
})();
</script>
</body>
</html>`;
}

async function readJsonBody(request: IncomingMessage): Promise<{ initData?: unknown }> {
  return await new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
      if (Buffer.byteLength(body, "utf8") > MAX_INIT_DATA_BYTES * 2) {
        reject(new Error("request_too_large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body) as { initData?: unknown });
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function proxyToGraph(request: IncomingMessage, response: ServerResponse): void {
  const upstream = httpRequest({
    hostname: UI_HOST,
    port: UI_PORT,
    path: request.url || "/",
    method: request.method,
    headers: {
      ...request.headers,
      host: `${UI_HOST}:${UI_PORT}`,
      connection: "close",
      "x-forwarded-host": request.headers.host ?? "",
      "x-forwarded-proto": "https",
    },
    timeout: 15_000,
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    delete headers["content-security-policy"];
    delete headers["x-frame-options"];
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
  });

  upstream.on("timeout", () => upstream.destroy(new Error("Code Graph upstream timed out")));
  upstream.on("error", (error) => {
    logger.warn("[CodeGraph] UI proxy request failed", error);
    if (!response.headersSent) sendJson(response, 503, { error: "Code Graph UI is starting or unavailable" });
    else response.destroy(error);
  });

  if (request.method === "GET" || request.method === "HEAD") upstream.end();
  else request.pipe(upstream);
}

function startUiProcess(): void {
  if (uiProcess && uiProcess.exitCode === null) return;
  const env = {
    ...process.env,
    CBM_CACHE_DIR: "/data/.cache/codebase-memory-mcp",
    CBM_ALLOWED_ROOT: "/data",
    HOME: "/data",
    XDG_CONFIG_HOME: "/data/.config",
    XDG_DATA_HOME: "/data/.local/share",
    XDG_CACHE_HOME: "/data/.cache",
  };
  uiProcess = spawn("/usr/local/bin/codebase-memory-mcp", ["--ui=true", `--port=${UI_PORT}`], {
    cwd: "/data/workspace",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  uiProcess.stdout.on("data", (chunk: Buffer) => logger.debug(`[CodeGraph] ${chunk.toString().trim()}`));
  uiProcess.stderr.on("data", (chunk: Buffer) => logger.info(`[CodeGraph] ${chunk.toString().trim()}`));
  uiProcess.on("exit", (code, signal) => {
    logger.warn(`[CodeGraph] UI process exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    uiProcess = null;
  });
  uiProcess.on("error", (error) => logger.error("[CodeGraph] Failed to start UI process", error));
}

export async function startCodeGraphWebServer(): Promise<() => void> {
  if (webServer) return () => stopCodeGraphWebServer();
  const webAppUrl = getPublicWebAppUrl();
  if (!webAppUrl) {
    logger.warn("[CodeGraph] No public URL available; Mini App button will be hidden until CODE_GRAPH_WEB_APP_URL or RAILWAY_PUBLIC_DOMAIN is present.");
  }

  startUiProcess();
  const port = Number(process.env.PORT ?? "8080");
  webServer = createServer(async (request, response) => {
    if (request.url === "/health" || request.url === "/healthz") {
      sendJson(response, 200, { ok: true, codeGraph: true, uiPort: UI_PORT });
      return;
    }

    if (request.url === "/__code-graph/auth" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (typeof body.initData !== "string") { sendJson(response, 400, { error: "Missing Telegram initData" }); return; }
        const userId = validateTelegramInitData(body.initData);
        if (!userId) { sendJson(response, 403, { error: "Invalid Telegram authorization" }); return; }
        response.writeHead(204, {
          "set-cookie": `${SESSION_COOKIE}=${createSessionCookie(userId)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
          "cache-control": "no-store",
        });
        response.end();
      } catch {
        sendJson(response, 400, { error: "Invalid authorization request" });
      }
      return;
    }

    if (!validateSessionCookie(cookieValue(request))) {
      sendHtml(response, 200, graphGateHtml());
      return;
    }

    proxyToGraph(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    webServer?.once("error", reject);
    webServer?.listen(port, "0.0.0.0", () => resolve());
  });
  logger.info(`[CodeGraph] Mini App web server listening on :${port}; public=${webAppUrl ?? "unconfigured"}; upstream=${UI_HOST}:${UI_PORT}`);

  return () => stopCodeGraphWebServer();
}

export function stopCodeGraphWebServer(): void {
  if (webServer) {
    webServer.close();
    webServer = null;
  }
  if (uiProcess) {
    uiProcess.kill("SIGTERM");
    uiProcess = null;
  }
}

export function clearCodeGraphSessionHash(): string {
  return createHash("sha256").update(config.telegram.token).digest("hex");
}

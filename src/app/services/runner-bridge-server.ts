import { createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { logger } from "../../utils/logger.js";

const RUNNER_BRIDGE_PORT = 3000;
const RUNNER_CONNECT_PATH = "/runner/v1/connect";
const INTERNAL_ACTION_PATH = "/internal/runner/action";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const OIDC_AUDIENCE = "opencode-telegram-runner";
const TRUSTED_REPOSITORY = "aminsh35322088-ctrl/GitHub-Runner-Lab";
const TRUSTED_REF = "refs/heads/main";
const TRUSTED_WORKFLOW_REF =
  "aminsh35322088-ctrl/GitHub-Runner-Lab/.github/workflows/rdc-lab.yml@refs/heads/main";
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;
const MAX_ACTION_TIMEOUT_MS = 15 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
const JWKS_CACHE_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 30;

const RUNNER_ACTIONS = new Set([
  "status",
  "exec",
  "job.start",
  "job.status",
  "job.logs",
  "job.wait",
  "job.stop",
  "file.read",
  "file.write",
  "file.list",
  "file.search",
  "workspace.prepare",
  "validate",
]);

interface RunnerRequest {
  type: "request";
  requestId: string;
  action: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}

interface RunnerResponse {
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface RunnerAuthMessage {
  type: "auth";
  token: string;
}

interface GitHubOidcClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  repository?: string;
  ref?: string;
  workflow_ref?: string;
  run_id?: string;
  run_attempt?: string;
  sha?: string;
  runner_environment?: string;
}

interface GitHubJwk {
  kid?: string;
  kty?: string;
  use?: string;
  n?: string;
  e?: string;
  alg?: string;
  [key: string]: unknown;
}

interface ActiveRunner {
  socket: WebSocket;
  claims: GitHubOidcClaims;
  connectedAt: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let httpServer: HttpServer | null = null;
let webSocketServer: WebSocketServer | null = null;
let activeRunner: ActiveRunner | null = null;
let cachedJwks: { expiresAt: number; keys: GitHubJwk[] } | null = null;
const pendingRequests = new Map<string, PendingRequest>();

function decodeBase64UrlJson(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

function audienceMatches(aud: unknown): boolean {
  return typeof aud === "string"
    ? aud === OIDC_AUDIENCE
    : Array.isArray(aud) && aud.includes(OIDC_AUDIENCE);
}

async function loadJwks(): Promise<GitHubJwk[]> {
  const now = Date.now();
  if (cachedJwks && cachedJwks.expiresAt > now) return cachedJwks.keys;

  const response = await fetch(OIDC_JWKS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub OIDC JWKS fetch failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(payload.keys)) {
    throw new Error("GitHub OIDC JWKS payload is invalid");
  }

  const keys = payload.keys.filter(
    (key): key is GitHubJwk => Boolean(key && typeof key === "object"),
  );
  cachedJwks = { expiresAt: now + JWKS_CACHE_MS, keys };
  return keys;
}

export async function verifyRunnerOidcToken(token: string): Promise<GitHubOidcClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("OIDC token must be a JWT");

  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeBase64UrlJson(headerPart!);
  const claims = decodeBase64UrlJson(payloadPart!) as GitHubOidcClaims;

  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("OIDC token signing header is not accepted");
  }

  const keys = await loadJwks();
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) {
    cachedJwks = null;
    const refreshed = await loadJwks();
    const retryJwk = refreshed.find((candidate) => candidate.kid === header.kid);
    if (!retryJwk) throw new Error("OIDC signing key is unknown");
    return verifyRunnerOidcTokenWithJwk(token, retryJwk, claims);
  }
  return verifyRunnerOidcTokenWithJwk(token, jwk, claims);
}

function verifyRunnerOidcTokenWithJwk(
  token: string,
  jwk: GitHubJwk,
  claims: GitHubOidcClaims,
): GitHubOidcClaims {
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    key,
    Buffer.from(signaturePart!, "base64url"),
  );
  if (!valid) throw new Error("OIDC token signature is invalid");

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.iss !== OIDC_ISSUER) throw new Error("OIDC issuer is not trusted");
  if (!audienceMatches(claims.aud)) throw new Error("OIDC audience is not trusted");
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error("OIDC token is expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("OIDC token is not active yet");
  }
  if (claims.repository !== TRUSTED_REPOSITORY) {
    throw new Error("OIDC repository is not trusted");
  }
  if (claims.ref !== TRUSTED_REF) throw new Error("OIDC ref is not trusted");
  if (claims.workflow_ref !== TRUSTED_WORKFLOW_REF) {
    throw new Error("OIDC workflow is not trusted");
  }
  if (claims.runner_environment && claims.runner_environment !== "github-hosted") {
    throw new Error("OIDC runner environment is not trusted");
  }
  return claims;
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function rejectPendingRequests(reason: string): void {
  for (const [requestId, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingRequests.delete(requestId);
  }
}

function activateRunner(socket: WebSocket, claims: GitHubOidcClaims): void {
  const previous = activeRunner;
  activeRunner = { socket, claims, connectedAt: Date.now() };
  if (previous && previous.socket !== socket && previous.socket.readyState === WebSocket.OPEN) {
    previous.socket.close(4001, "superseded by newer runner");
  }

  logger.info(
    `[RunnerBridge] runner connected: runId=${claims.run_id ?? "unknown"} attempt=${claims.run_attempt ?? "unknown"} sha=${claims.sha ?? "unknown"}`,
  );
}

function handleRunnerResponse(message: RunnerResponse): void {
  const pending = pendingRequests.get(message.requestId);
  if (!pending) return;
  pendingRequests.delete(message.requestId);
  clearTimeout(pending.timer);
  if (message.ok) {
    pending.resolve(message.result);
  } else {
    pending.reject(new Error(message.error || "runner action failed"));
  }
}

function normalizeTimeout(value: unknown): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : DEFAULT_ACTION_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 1_000), MAX_ACTION_TIMEOUT_MS);
}

export async function dispatchRunnerAction(
  action: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
): Promise<unknown> {
  if (!RUNNER_ACTIONS.has(action)) throw new Error(`unsupported runner action: ${action}`);
  const runner = activeRunner;
  if (!runner || runner.socket.readyState !== WebSocket.OPEN) {
    throw new Error("runner is not connected");
  }

  const requestId = randomUUID();
  const requestTimeout = normalizeTimeout(timeoutMs);
  const message: RunnerRequest = {
    type: "request",
    requestId,
    action,
    args,
    timeoutMs: requestTimeout,
  };

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`runner action timed out after ${requestTimeout}ms`));
    }, requestTimeout + 5_000);

    pendingRequests.set(requestId, { resolve, reject, timer });
    runner.socket.send(JSON.stringify(message), (error) => {
      if (!error) return;
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    });
  });
}

function configureWebSocketServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

  server.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== RUNNER_CONNECT_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (socket) => {
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(4003, "authentication timeout"), AUTH_TIMEOUT_MS);

    socket.on("message", async (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(4002, "invalid json");
        return;
      }

      if (!authenticated) {
        const auth = message as Partial<RunnerAuthMessage>;
        if (auth.type !== "auth" || typeof auth.token !== "string") {
          socket.close(4003, "authentication required");
          return;
        }
        try {
          const claims = await verifyRunnerOidcToken(auth.token);
          authenticated = true;
          clearTimeout(authTimer);
          activateRunner(socket, claims);
          socket.send(
            JSON.stringify({
              type: "auth.ok",
              runId: claims.run_id ?? null,
              repository: claims.repository ?? null,
            }),
          );
        } catch (error) {
          logger.warn("[RunnerBridge] runner authentication rejected", error);
          socket.close(4003, "authentication failed");
        }
        return;
      }

      const response = message as Partial<RunnerResponse>;
      if (
        response.type === "response" &&
        typeof response.requestId === "string" &&
        typeof response.ok === "boolean"
      ) {
        handleRunnerResponse(response as RunnerResponse);
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (activeRunner?.socket === socket) {
        const runId = activeRunner.claims.run_id ?? "unknown";
        activeRunner = null;
        rejectPendingRequests("runner disconnected");
        logger.warn(`[RunnerBridge] runner disconnected: runId=${runId}`);
      }
    });

    socket.on("error", (error) => {
      logger.warn("[RunnerBridge] websocket error", error);
    });
  });

  return wss;
}

export async function startRunnerBridgeServer(port = RUNNER_BRIDGE_PORT): Promise<void> {
  if (httpServer) return;

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    let pathname = "/";
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      writeJson(response, 400, { ok: false, error: "invalid url" });
      return;
    }

    if (method === "GET" && pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        service: "opencode-runner-bridge",
        runnerConnected: activeRunner?.socket.readyState === WebSocket.OPEN,
        runId: activeRunner?.claims.run_id ?? null,
      });
      return;
    }

    if (method === "POST" && pathname === INTERNAL_ACTION_PATH) {
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { ok: false, error: "loopback only" });
        return;
      }

      try {
        const payload = await readJsonBody(request);
        const action = typeof payload.action === "string" ? payload.action : "";
        const args =
          payload.args && typeof payload.args === "object" && !Array.isArray(payload.args)
            ? (payload.args as Record<string, unknown>)
            : {};
        const result = await dispatchRunnerAction(
          action,
          args,
          normalizeTimeout(payload.timeoutMs),
        );
        writeJson(response, 200, { ok: true, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unavailable = /runner is not connected|runner disconnected/u.test(message);
        writeJson(response, unavailable ? 503 : 400, { ok: false, error: message });
      }
      return;
    }

    writeJson(response, 404, { ok: false, error: "not found" });
  });

  webSocketServer = configureWebSocketServer(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  httpServer = server;
  logger.info(`[RunnerBridge] server ready: port=${port}`);
}

export async function stopRunnerBridgeServer(): Promise<void> {
  rejectPendingRequests("runner bridge stopped");
  activeRunner?.socket.close(1001, "server stopping");
  activeRunner = null;

  if (webSocketServer) {
    webSocketServer.close();
    webSocketServer = null;
  }
  if (!httpServer) return;

  const server = httpServer;
  httpServer = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export function getRunnerBridgeStatus(): {
  connected: boolean;
  runId: string | null;
  connectedAt: number | null;
} {
  return {
    connected: activeRunner?.socket.readyState === WebSocket.OPEN,
    runId: activeRunner?.claims.run_id ?? null,
    connectedAt: activeRunner?.connectedAt ?? null,
  };
}

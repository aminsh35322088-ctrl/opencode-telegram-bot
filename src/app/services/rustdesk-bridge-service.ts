export const RUSTDESK_ACTIONS = [
  "bridge.health",
  "devices.list",
  "device.info",
  "device.connect",
  "device.disconnect",
  "terminal.exec",
  "terminal.open",
  "terminal.write",
  "terminal.read",
  "terminal.close",
  "screen.capture",
  "mouse.move",
  "mouse.click",
  "mouse.doubleClick",
  "mouse.drag",
  "mouse.scroll",
  "keyboard.type",
  "keyboard.press",
  "touch.tap",
  "touch.longPress",
  "touch.swipe",
  "clipboard.read",
  "clipboard.write",
  "files.list",
  "files.read",
  "files.upload",
  "files.download",
  "system.info",
  "system.restart",
] as const;

export type RustDeskAction = (typeof RUSTDESK_ACTIONS)[number];

export interface RustDeskCapabilities {
  terminal?: boolean;
  screen?: boolean;
  mouse?: boolean;
  keyboard?: boolean;
  touch?: boolean;
  clipboard?: boolean;
  files?: boolean;
  audio?: boolean;
  camera?: boolean;
  portForward?: boolean;
  restart?: boolean;
}

export interface RustDeskDevice {
  id: string;
  name?: string;
  online?: boolean;
  os?: {
    family?: string;
    name?: string;
    version?: string;
    arch?: string;
  };
  capabilities?: RustDeskCapabilities;
}

export interface RustDeskActionRequest {
  action: RustDeskAction;
  deviceId?: string;
  sessionId?: string;
  command?: string;
  shell?: string;
  text?: string;
  keys?: string[];
  path?: string;
  remotePath?: string;
  contentBase64?: string;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  button?: "left" | "right" | "middle";
  deltaX?: number;
  deltaY?: number;
  durationMs?: number;
  timeoutMs?: number;
}

export interface RustDeskBridgeClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEVICE_OPTIONAL_ACTIONS = new Set<RustDeskAction>(["bridge.health", "devices.list"]);
const ACTION_SET = new Set<string>(RUSTDESK_ACTIONS);

function requireText(value: string | undefined, field: string, action: RustDeskAction): void {
  if (!value?.trim()) throw new Error(`${action} requires ${field}`);
}

function requireNumber(value: number | undefined, field: string, action: RustDeskAction): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${action} requires a finite ${field}`);
  }
}

function requireCoordinates(request: RustDeskActionRequest, action: RustDeskAction): void {
  requireNumber(request.x, "x", action);
  requireNumber(request.y, "y", action);
}

function requireDragCoordinates(request: RustDeskActionRequest, action: RustDeskAction): void {
  requireNumber(request.fromX, "fromX", action);
  requireNumber(request.fromY, "fromY", action);
  requireNumber(request.toX, "toX", action);
  requireNumber(request.toY, "toY", action);
}

export function validateRustDeskActionRequest(request: RustDeskActionRequest): void {
  if (!ACTION_SET.has(request.action)) throw new Error(`Unsupported RustDesk action: ${request.action}`);
  if (!DEVICE_OPTIONAL_ACTIONS.has(request.action)) requireText(request.deviceId, "deviceId", request.action);

  switch (request.action) {
    case "terminal.exec":
      requireText(request.command, "command", request.action);
      break;
    case "terminal.write":
      requireText(request.sessionId, "sessionId", request.action);
      if (request.text === undefined) throw new Error(`${request.action} requires text`);
      break;
    case "terminal.read":
    case "terminal.close":
      requireText(request.sessionId, "sessionId", request.action);
      break;
    case "mouse.move":
    case "mouse.click":
    case "mouse.doubleClick":
    case "touch.tap":
    case "touch.longPress":
      requireCoordinates(request, request.action);
      break;
    case "mouse.drag":
    case "touch.swipe":
      requireDragCoordinates(request, request.action);
      break;
    case "mouse.scroll":
      if (!Number.isFinite(request.deltaX) && !Number.isFinite(request.deltaY)) {
        throw new Error(`${request.action} requires deltaX or deltaY`);
      }
      break;
    case "keyboard.type":
    case "clipboard.write":
      if (request.text === undefined) throw new Error(`${request.action} requires text`);
      break;
    case "keyboard.press":
      if (!request.keys?.length || request.keys.some((key) => !key.trim())) {
        throw new Error(`${request.action} requires one or more keys`);
      }
      break;
    case "files.list":
    case "files.read":
      requireText(request.path, "path", request.action);
      break;
    case "files.upload":
      requireText(request.remotePath, "remotePath", request.action);
      requireText(request.contentBase64, "contentBase64", request.action);
      break;
    case "files.download":
      requireText(request.remotePath, "remotePath", request.action);
      break;
    default:
      break;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RUSTDESK_BRIDGE_URL must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

function isLoopbackUrl(value: string): boolean {
  const host = new URL(value).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.trunc(value ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS));
}

function errorMessageFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as { error?: unknown; message?: unknown };
  if (typeof value.error === "string" && value.error.trim()) return value.error.trim();
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return null;
}

export class RustDeskBridgeClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RustDeskBridgeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token?.trim() || undefined;
    this.timeoutMs = clampTimeout(options.timeoutMs);
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!this.token && !isLoopbackUrl(this.baseUrl)) {
      throw new Error("RUSTDESK_BRIDGE_TOKEN is required when the bridge is not on loopback");
    }
  }

  async execute(request: RustDeskActionRequest): Promise<unknown> {
    validateRustDeskActionRequest(request);
    const controller = new AbortController();
    const timeoutMs = clampTimeout(request.timeoutMs ?? this.timeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;

      const response = await this.fetchImpl(`${this.baseUrl}/v1/action`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      if (text.trim()) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          payload = { output: text };
        }
      }

      if (!response.ok) {
        const detail = errorMessageFromPayload(payload);
        throw new Error(`RustDesk bridge HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`RustDesk bridge timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRustDeskBridgeClientFromEnv(): RustDeskBridgeClient {
  const baseUrl = process.env.RUSTDESK_BRIDGE_URL?.trim();
  if (!baseUrl) {
    throw new Error("RustDesk agent tool is not configured. Set RUSTDESK_BRIDGE_URL first.");
  }

  const timeoutRaw = process.env.RUSTDESK_BRIDGE_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  return new RustDeskBridgeClient({
    baseUrl,
    token: process.env.RUSTDESK_BRIDGE_TOKEN,
    timeoutMs,
  });
}

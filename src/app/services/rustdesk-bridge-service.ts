import { promises as fs } from "node:fs";
import path from "node:path";

export const RUSTDESK_BRIDGE_CONTRACT_VERSION = 4;

export const RUSTDESK_ACTIONS = [
  "bridge.health",
  "servers.list",
  "servers.get",
  "servers.test",
  "devices.list",
  "devices.get",
  "devices.connect",
  "session.connectTemporary",
  "connections.list",
  "connection.status",
  "connection.disconnect",
  "terminal.open",
  "terminal.write",
  "terminal.read",
  "terminal.resize",
  "terminal.close",
  "terminal.exec",
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

export type RustDeskAuthMode =
  | "permanent-password"
  | "temporary-password"
  | "manual-approval"
  | "password-or-approval";

export type RustDeskTemporaryAuthMode = Exclude<RustDeskAuthMode, "permanent-password">;

export type RustDeskPublicLoginProvider = "github" | "google" | "microsoft";

export interface RustDeskPublicAccountStatus {
  loggedIn: boolean;
  state?: string;
  failedMessage?: string;
  authUrl?: string;
}

export type RustDeskServerSelector =
  | { kind: "public" }
  | { kind: "saved-custom"; serverProfileId: string }
  | { kind: "one-time-custom"; idServer: string; relayServer?: string; apiServer?: string };

export type RustDeskConnectionStatus =
  | "connecting"
  | "waiting_remote_approval"
  | "credential_required"
  | "connected"
  | "disconnected"
  | "failed";

export interface RustDeskCapabilities {
  terminal?: boolean;
  screen?: boolean;
  mouse?: boolean;
  keyboard?: boolean;
  touch?: boolean;
  clipboard?: boolean;
  files?: boolean;
  restart?: boolean;
}

export interface RustDeskDevice {
  id: string;
  name?: string;
  rustdeskId?: string;
  serverProfileId?: string;
  credentialConfigured?: boolean;
  trustedController?: boolean;
  online?: boolean;
  os?: {
    family?: string;
    name?: string;
    version?: string;
    arch?: string;
  };
  capabilities?: RustDeskCapabilities;
}

export interface RustDeskServerProfile {
  id: string;
  name: string;
  kind: "public" | "custom";
  idServer?: string;
  relayServer?: string;
  apiServer?: string;
  keyConfigured?: boolean;
}

export interface RustDeskServerProfileUpsert {
  id: string;
  name: string;
  idServer: string;
  relayServer?: string;
  apiServer?: string;
  serverKey?: string;
  clearServerKey?: boolean;
}

export interface RustDeskDeviceUpsert {
  id: string;
  name?: string;
  rustdeskId: string;
  serverProfileId: string;
  forceRelay?: boolean;
  credential?: string;
  clearCredential?: boolean;
}

export interface RustDeskConnection {
  connectionId: string;
  kind: "permanent" | "temporary";
  status: RustDeskConnectionStatus;
  deviceId?: string;
  rustdeskId: string;
  serverProfileId?: string;
  serverKind: "public" | "saved-custom" | "one-time-custom";
  authMode: RustDeskAuthMode;
  capabilities?: RustDeskCapabilities;
  credentialRequestId?: string;
  errorCode?: string;
}

export interface RustDeskActionRequest {
  action: RustDeskAction;
  deviceId?: string;
  connectionId?: string;
  sessionScope?: string;
  terminalId?: string;
  rustdeskId?: string;
  serverProfileId?: string;
  server?: RustDeskServerSelector;
  authMode?: RustDeskTemporaryAuthMode;
  command?: string;
  text?: string;
  keys?: string[];
  path?: string;
  remotePath?: string;
  contentBase64?: string;
  rows?: number;
  cols?: number;
  displayIndex?: number;
  imageFormat?: "png" | "jpeg" | "webp";
  quality?: number;
  maxBytes?: number;
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
  permissionGrantId?: string;
}

export interface RustDeskBridgeClientOptions {
  baseUrl: string;
  token?: string;
  controlToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type RustDeskPermissionRisk = "read" | "interactive" | "mutating" | "destructive";
export type RustDeskPermissionMode = "allow" | "ask" | "always-ask";

export interface RustDeskPermissionChallenge {
  action: RustDeskAction;
  connectionId?: string;
  risk?: RustDeskPermissionRisk;
  permission?: RustDeskPermissionMode;
}

export interface RustDeskPermissionGrantRequest {
  action: RustDeskAction;
  connectionId?: string;
  sessionScope?: string;
  scope?: "once" | "connection";
  permissionGrantId?: string;
}

export interface RustDeskPermissionGrantResponse {
  ok: boolean;
  permissionGrantId: string;
  action?: string;
  scope?: "once" | "connection";
  expiresInSeconds?: number;
  risk?: RustDeskPermissionRisk;
  permission?: RustDeskPermissionMode;
  idempotent?: boolean;
}

export interface RustDeskPermissionGrantHandoffRequest {
  correlationId: string;
  action: RustDeskAction;
  sessionScope: string;
  connectionId?: string;
}

export interface RustDeskCredentialSubmission {
  credentialRequestId: string;
  credential: string;
  trustThisDevice?: boolean;
}

export interface RustDeskCredentialSubmissionResponse {
  ok: boolean;
  connectionId: string;
  credentialRequestId?: string;
  status?: RustDeskConnectionStatus;
  accepted?: boolean;
  idempotent?: boolean;
}

export interface RustDeskBridgeErrorPayload {
  ok?: boolean;
  error?: string;
  message?: string;
  errorCode?: string;
  risk?: RustDeskPermissionRisk;
  permission?: RustDeskPermissionMode;
  [key: string]: unknown;
}

export class RustDeskBridgeHttpError extends Error {
  readonly status: number;
  readonly errorCode?: string;
  readonly payload: RustDeskBridgeErrorPayload | null;

  constructor(status: number, payload: RustDeskBridgeErrorPayload | null) {
    const detail = errorMessageFromPayload(payload);
    super(`RustDesk bridge HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "RustDeskBridgeHttpError";
    this.status = status;
    this.errorCode = typeof payload?.errorCode === "string" ? payload.errorCode : undefined;
    this.payload = payload;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const ACTION_SET = new Set<string>(RUSTDESK_ACTIONS);
const TEMPORARY_AUTH_MODES = new Set<RustDeskTemporaryAuthMode>([
  "temporary-password",
  "manual-approval",
  "password-or-approval",
]);
const CONNECTION_ACTIONS = new Set<RustDeskAction>([
  "connection.status",
  "connection.disconnect",
  "terminal.open",
  "terminal.write",
  "terminal.read",
  "terminal.resize",
  "terminal.close",
  "terminal.exec",
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
]);
const SESSION_SCOPED_ACTIONS = new Set<RustDeskAction>([
  "devices.connect",
  "session.connectTemporary",
  "connections.list",
  ...CONNECTION_ACTIONS,
]);
const TERMINAL_ID_ACTIONS = new Set<RustDeskAction>([
  "terminal.write",
  "terminal.read",
  "terminal.resize",
  "terminal.close",
]);
const SECRET_FIELD_NAMES = new Set([
  "password",
  "passcode",
  "token",
  "secret",
  "key",
  "privatekey",
  "serverkey",
  "apikey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "twofactorcode",
  "2facode",
]);

function requireText(value: string | undefined, field: string, action: RustDeskAction): void {
  if (!value?.trim()) throw new Error(`${action} requires ${field}`);
}

function requireNumber(value: number | undefined, field: string, action: RustDeskAction): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${action} requires a finite ${field}`);
  }
}

function requirePositiveInteger(value: number | undefined, field: string, action: RustDeskAction): void {
  requireNumber(value, field, action);
  if (!Number.isInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`${action} requires ${field} to be a positive integer`);
  }
}

function validateOptionalPositiveInteger(value: number | undefined, field: string, action: RustDeskAction): void {
  if (value !== undefined) requirePositiveInteger(value, field, action);
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rejectSecretFields(value: unknown, path = "args"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeFieldName(key);
    if (SECRET_FIELD_NAMES.has(normalized)) {
      throw new Error(`RustDesk model actions cannot carry secret field ${path}.${key}`);
    }
    rejectSecretFields(child, `${path}.${key}`);
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

function validateServerSelector(server: RustDeskServerSelector | undefined, action: RustDeskAction): void {
  if (!server || typeof server !== "object") throw new Error(`${action} requires server selection`);

  switch (server.kind) {
    case "public":
      break;
    case "saved-custom":
      requireText(server.serverProfileId, "server.serverProfileId", action);
      break;
    case "one-time-custom":
      requireText(server.idServer, "server.idServer", action);
      break;
    default:
      throw new Error(`${action} has an unsupported server kind`);
  }
}

function validateSavedDeviceConnect(request: RustDeskActionRequest): void {
  requireText(request.deviceId, "deviceId", request.action);
  if (request.rustdeskId || request.server || request.serverProfileId || request.authMode) {
    throw new Error("devices.connect uses the saved device server/auth configuration and does not accept overrides");
  }
}

function validateTemporaryConnect(request: RustDeskActionRequest): void {
  requireText(request.rustdeskId, "rustdeskId", request.action);
  validateServerSelector(request.server, request.action);
  if (!request.authMode || !TEMPORARY_AUTH_MODES.has(request.authMode)) {
    throw new Error(
      `${request.action} requires authMode temporary-password, manual-approval, or password-or-approval`,
    );
  }
}

function validateServerTest(request: RustDeskActionRequest): void {
  const hasProfile = Boolean(request.serverProfileId?.trim());
  const hasServer = request.server !== undefined;
  if (hasProfile === hasServer) {
    throw new Error("servers.test requires exactly one of serverProfileId or server");
  }
  if (hasServer) validateServerSelector(request.server, request.action);
}

export function validateRustDeskActionRequest(request: RustDeskActionRequest): void {
  if (!ACTION_SET.has(request.action)) throw new Error(`Unsupported RustDesk action: ${request.action}`);
  rejectSecretFields(request);

  if (SESSION_SCOPED_ACTIONS.has(request.action)) requireText(request.sessionScope, "sessionScope", request.action);
  if (CONNECTION_ACTIONS.has(request.action)) requireText(request.connectionId, "connectionId", request.action);
  if (TERMINAL_ID_ACTIONS.has(request.action)) requireText(request.terminalId, "terminalId", request.action);

  switch (request.action) {
    case "servers.get":
      requireText(request.serverProfileId, "serverProfileId", request.action);
      break;
    case "servers.test":
      validateServerTest(request);
      break;
    case "devices.get":
      requireText(request.deviceId, "deviceId", request.action);
      break;
    case "devices.connect":
      validateSavedDeviceConnect(request);
      break;
    case "session.connectTemporary":
      validateTemporaryConnect(request);
      break;
    case "terminal.open":
      validateOptionalPositiveInteger(request.rows, "rows", request.action);
      validateOptionalPositiveInteger(request.cols, "cols", request.action);
      break;
    case "terminal.exec":
      requireText(request.command, "command", request.action);
      break;
    case "terminal.write":
      if (request.text === undefined) throw new Error(`${request.action} requires text`);
      break;
    case "terminal.resize":
      requirePositiveInteger(request.rows, "rows", request.action);
      requirePositiveInteger(request.cols, "cols", request.action);
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


const RUSTDESK_PERMISSION_HANDOFF_TTL_MS = 60_000;
const RUSTDESK_PERMISSION_CORRELATION_RE = /^[a-f0-9]{32,128}$/u;

interface RustDeskPermissionGrantHandoffRecord extends RustDeskPermissionGrantHandoffRequest {
  permissionGrantId: string;
  expiresAt: number;
}

function rustDeskPermissionHandoffDir(): string {
  const home = process.env.OPENCODE_TELEGRAM_HOME?.trim() || process.cwd();
  return path.join(home, "run", "rustdesk-permission-grants");
}

function validateRustDeskPermissionCorrelationId(correlationId: string): string {
  const value = correlationId.trim().toLowerCase();
  if (!RUSTDESK_PERMISSION_CORRELATION_RE.test(value)) {
    throw new Error("Invalid RustDesk permission approval correlation id");
  }
  return value;
}

function rustDeskPermissionHandoffPath(correlationId: string): string {
  return path.join(
    rustDeskPermissionHandoffDir(),
    `${validateRustDeskPermissionCorrelationId(correlationId)}.json`,
  );
}

export async function writeRustDeskPermissionGrantHandoff(
  request: RustDeskPermissionGrantHandoffRequest,
  grant: RustDeskPermissionGrantResponse,
): Promise<void> {
  if (!request.sessionScope.trim()) {
    throw new Error("RustDesk permission handoff requires sessionScope");
  }
  if (!grant.permissionGrantId?.trim()) {
    throw new Error("RustDesk permission handoff requires a Bridge permissionGrantId");
  }

  const directory = rustDeskPermissionHandoffDir();
  const filePath = rustDeskPermissionHandoffPath(request.correlationId);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const record: RustDeskPermissionGrantHandoffRecord = {
    correlationId: validateRustDeskPermissionCorrelationId(request.correlationId),
    action: request.action,
    sessionScope: request.sessionScope,
    connectionId: request.connectionId,
    permissionGrantId: grant.permissionGrantId,
    expiresAt: Date.now() + RUSTDESK_PERMISSION_HANDOFF_TTL_MS,
  };

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function discardRustDeskPermissionGrantHandoff(correlationId: string): Promise<void> {
  await fs.unlink(rustDeskPermissionHandoffPath(correlationId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function consumeRustDeskPermissionGrantHandoff(
  request: RustDeskPermissionGrantHandoffRequest,
): Promise<{ permissionGrantId: string }> {
  const filePath = rustDeskPermissionHandoffPath(request.correlationId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("RustDesk permission approval handoff was not found");
    }
    throw error;
  }

  await fs.unlink(filePath).catch(() => {});

  let record: RustDeskPermissionGrantHandoffRecord;
  try {
    record = JSON.parse(raw) as RustDeskPermissionGrantHandoffRecord;
  } catch {
    throw new Error("RustDesk permission approval handoff is invalid");
  }

  const expectedCorrelationId = validateRustDeskPermissionCorrelationId(request.correlationId);
  if (
    record.correlationId !== expectedCorrelationId ||
    record.action !== request.action ||
    record.sessionScope !== request.sessionScope ||
    (record.connectionId ?? undefined) !== (request.connectionId ?? undefined)
  ) {
    throw new Error("RustDesk permission approval handoff does not match the requested action scope");
  }
  if (!Number.isFinite(record.expiresAt) || record.expiresAt < Date.now()) {
    throw new Error("RustDesk permission approval handoff expired");
  }
  if (typeof record.permissionGrantId !== "string" || !record.permissionGrantId.trim()) {
    throw new Error("RustDesk permission approval handoff is missing permissionGrantId");
  }
  return { permissionGrantId: record.permissionGrantId };
}

export async function grantApprovedRustDeskPermission(
  request: RustDeskPermissionGrantHandoffRequest,
): Promise<void> {
  const client = createRustDeskBridgeClientFromEnv();
  const grant = await client.grantPermission({
    action: request.action,
    connectionId: request.connectionId,
    sessionScope: request.sessionScope,
    scope: "once",
  });
  await writeRustDeskPermissionGrantHandoff(request, grant);
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
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isSecureTransport(value: string): boolean {
  return new URL(value).protocol === "https:";
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.trunc(value ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS));
}

function parsePublicAccountStatus(payload: unknown): RustDeskPublicAccountStatus {
  const root =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const raw = root.account;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("RustDesk bridge returned an invalid public account response");
  }
  const account = raw as Record<string, unknown>;
  if (typeof account.loggedIn !== "boolean") {
    throw new Error("RustDesk bridge returned public account status without loggedIn");
  }
  return {
    loggedIn: account.loggedIn,
    state: typeof account.state === "string" && account.state.trim() ? account.state.trim() : undefined,
    failedMessage:
      typeof account.failedMessage === "string" && account.failedMessage.trim()
        ? account.failedMessage.trim()
        : undefined,
    authUrl:
      typeof account.authUrl === "string" && /^https:\/\//i.test(account.authUrl.trim())
        ? account.authUrl.trim()
        : undefined,
  };
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
  private readonly controlToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RustDeskBridgeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token?.trim() || undefined;
    this.controlToken = options.controlToken?.trim() || undefined;
    this.timeoutMs = clampTimeout(options.timeoutMs);
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!isLoopbackUrl(this.baseUrl) && !isSecureTransport(this.baseUrl)) {
      throw new Error("Remote RustDesk bridges must use https");
    }
    if (!this.token && !isLoopbackUrl(this.baseUrl)) {
      throw new Error("RUSTDESK_BRIDGE_TOKEN is required when the bridge is not on loopback");
    }
  }

  async execute(request: RustDeskActionRequest): Promise<unknown> {
    validateRustDeskActionRequest(request);
    return this.request("/v1/action", request, this.token, request.timeoutMs);
  }

  async upsertServerProfile(request: RustDeskServerProfileUpsert): Promise<unknown> {
    if (!request.id.trim() || !request.name.trim() || !request.idServer.trim()) {
      throw new Error("RustDesk server profile requires id, name, and idServer");
    }
    return this.request(
      "/v1/control/server-profiles/upsert",
      request,
      this.requireControlToken(),
    );
  }

  async deleteServerProfile(id: string): Promise<unknown> {
    if (!id.trim()) throw new Error("RustDesk server profile id is required");
    return this.request(
      "/v1/control/server-profiles/delete",
      { id },
      this.requireControlToken(),
    );
  }

  async upsertDevice(request: RustDeskDeviceUpsert): Promise<unknown> {
    if (!request.id.trim() || !request.rustdeskId.trim() || !request.serverProfileId.trim()) {
      throw new Error("RustDesk device requires id, rustdeskId, and serverProfileId");
    }
    return this.request(
      "/v1/control/devices/upsert",
      request,
      this.requireControlToken(),
    );
  }

  async deleteDevice(id: string): Promise<unknown> {
    if (!id.trim()) throw new Error("RustDesk device id is required");
    return this.request(
      "/v1/control/devices/delete",
      { id },
      this.requireControlToken(),
    );
  }

  async getPublicAccountStatus(): Promise<RustDeskPublicAccountStatus> {
    return parsePublicAccountStatus(
      await this.request(
        "/v1/control/public-account/status",
        {},
        this.requireControlToken(),
      ),
    );
  }

  async startPublicAccountLogin(
    provider: RustDeskPublicLoginProvider,
  ): Promise<RustDeskPublicAccountStatus> {
    return parsePublicAccountStatus(
      await this.request(
        "/v1/control/public-account/login",
        { provider },
        this.requireControlToken(),
      ),
    );
  }

  async cancelPublicAccountLogin(): Promise<RustDeskPublicAccountStatus> {
    return parsePublicAccountStatus(
      await this.request(
        "/v1/control/public-account/cancel",
        {},
        this.requireControlToken(),
      ),
    );
  }

  async grantPermission(request: RustDeskPermissionGrantRequest): Promise<RustDeskPermissionGrantResponse> {
    const token = this.requireControlToken();
    const payload = await this.request("/v1/permission", request, token);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("RustDesk bridge returned an invalid permission grant response");
    }
    const grant = payload as Partial<RustDeskPermissionGrantResponse>;
    if (typeof grant.permissionGrantId !== "string" || !grant.permissionGrantId.trim()) {
      throw new Error("RustDesk bridge returned a permission grant without permissionGrantId");
    }
    return payload as RustDeskPermissionGrantResponse;
  }

  async submitCredential(
    request: RustDeskCredentialSubmission,
  ): Promise<RustDeskCredentialSubmissionResponse> {
    if (!request.credentialRequestId.trim() || !request.credential) {
      throw new Error("RustDesk credential submission requires credentialRequestId and credential");
    }
    const payload = await this.request("/v1/credential", request, this.requireControlToken());
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("RustDesk bridge returned an invalid credential submission response");
    }
    const response = payload as Partial<RustDeskCredentialSubmissionResponse>;
    if (response.ok !== true || typeof response.connectionId !== "string" || !response.connectionId.trim()) {
      throw new Error("RustDesk bridge returned an incomplete credential submission response");
    }
    if (
      response.credentialRequestId !== undefined &&
      response.credentialRequestId !== request.credentialRequestId
    ) {
      throw new Error("RustDesk bridge returned a mismatched credentialRequestId");
    }
    return payload as RustDeskCredentialSubmissionResponse;
  }

  async executeAuthorized(
    request: RustDeskActionRequest,
    authorize: (challenge: RustDeskPermissionChallenge) => Promise<void>,
  ): Promise<unknown> {
    try {
      return await this.execute(request);
    } catch (error) {
      if (!(error instanceof RustDeskBridgeHttpError) || error.errorCode !== "permission_required") {
        throw error;
      }

      this.requireControlToken();
      const payload = error.payload;
      const challenge: RustDeskPermissionChallenge = {
        action: request.action,
        connectionId: request.connectionId,
        risk: payload?.risk,
        permission: payload?.permission,
      };
      await authorize(challenge);

      const grant = await this.grantPermission({
        action: request.action,
        connectionId: request.connectionId,
        sessionScope: request.sessionScope,
        scope: "once",
      });
      return this.execute({ ...request, permissionGrantId: grant.permissionGrantId });
    }
  }

  private requireControlToken(): string {
    if (!this.controlToken) {
      throw new Error("RustDesk trusted control plane is unavailable in this process");
    }
    return this.controlToken;
  }

  private async request(
    endpoint: string,
    body: object,
    token: string | undefined,
    requestedTimeoutMs?: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = clampTimeout(requestedTimeoutMs ?? this.timeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (token) headers.Authorization = `Bearer ${token}`;

      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
        const structured =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as RustDeskBridgeErrorPayload)
            : null;
        throw new RustDeskBridgeHttpError(response.status, structured);
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
    controlToken: process.env.RUSTDESK_BRIDGE_CONTROL_TOKEN,
    timeoutMs,
  });
}

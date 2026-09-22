import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

interface RustDeskBridgeClient {
  execute(request: Record<string, unknown>): Promise<unknown>;
}

interface RustDeskPermissionGrantHandoffRequest {
  correlationId: string;
  action: string;
  sessionScope: string;
  connectionId?: string;
}

interface RustDeskBridgeModule {
  createRustDeskBridgeClientFromEnv(): RustDeskBridgeClient;
  consumeRustDeskPermissionGrantHandoff(
    request: RustDeskPermissionGrantHandoffRequest,
  ): Promise<{ permissionGrantId: string }>;
}

const DEFAULT_SERVICE_PATH = "/app/dist/app/services/rustdesk-bridge-service.js";
const DEFAULT_MAX_TRANSFER_BYTES = 8 * 1024 * 1024;
const BUTTONS = new Set(["left", "right", "middle"]);
const SERVER_KINDS = new Set(["public", "saved-custom", "one-time-custom"]);
const TEMPORARY_AUTH_MODES = new Set(["temporary-password", "manual-approval", "password-or-approval"]);
const IMAGE_FORMATS = new Set(["png", "jpeg", "webp"]);
const CREDENTIAL_WAIT_TIMEOUT_MS = 120_000;
const CONNECTION_POLL_INTERVAL_MS = 350;

function servicePath(): string {
  return process.env.RUSTDESK_BRIDGE_SERVICE_PATH?.trim() || DEFAULT_SERVICE_PATH;
}

async function getBridgeModule(): Promise<RustDeskBridgeModule> {
  return (await import(pathToFileURL(servicePath()).href)) as RustDeskBridgeModule;
}

async function getClient(): Promise<RustDeskBridgeClient> {
  return (await getBridgeModule()).createRustDeskBridgeClientFromEnv();
}

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseKeys(value?: string): string[] | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const keys = raw
    .split(/[+,]/)
    .map((key) => key.trim())
    .filter(Boolean);
  return keys.length ? keys : undefined;
}

function resolveInsideWorktree(worktree: string, value: string): string {
  const root = path.resolve(worktree);
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Local paths must stay inside the current worktree");
  }
  return target;
}

function maxTransferBytes(): number {
  const raw = Number(process.env.RUSTDESK_MAX_TRANSFER_BYTES ?? DEFAULT_MAX_TRANSFER_BYTES);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_TRANSFER_BYTES;
  return Math.max(1024, Math.min(Math.trunc(raw), 64 * 1024 * 1024));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getBase64(value: unknown, field: string): string | null {
  if (!isRecord(value)) return null;
  const encoded = value[field];
  return typeof encoded === "string" && encoded ? encoded : null;
}

function imageExtension(value: unknown): string {
  if (!isRecord(value) || typeof value.mimeType !== "string") return ".png";
  const mime = value.mimeType.toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return ".png";
}

function resultWithoutBinary(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const copy = { ...value };
  if (typeof copy.imageBase64 === "string") copy.imageBase64 = `[base64 omitted: ${copy.imageBase64.length} chars]`;
  if (typeof copy.contentBase64 === "string") copy.contentBase64 = `[base64 omitted: ${copy.contentBase64.length} chars]`;
  return copy;
}

function stringify(value: unknown): string {
  return JSON.stringify(resultWithoutBinary(value), null, 2);
}

function getConnection(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value.connection)) return null;
  return value.connection;
}

function permissionErrorDetails(error: unknown): { risk?: string; permission?: string } | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    errorCode?: unknown;
    payload?: { risk?: unknown; permission?: unknown } | null;
  };
  if (candidate.errorCode !== "permission_required") return null;
  return {
    risk: typeof candidate.payload?.risk === "string" ? candidate.payload.risk : undefined,
    permission:
      typeof candidate.payload?.permission === "string" ? candidate.payload.permission : undefined,
  };
}

function permissionPattern(action: string, request: Record<string, unknown>): string {
  const target =
    (typeof request.connectionId === "string" && request.connectionId) ||
    (typeof request.deviceId === "string" && request.deviceId) ||
    (typeof request.rustdeskId === "string" && request.rustdeskId) ||
    "bridge";
  return `${action}:${target}`;
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("RustDesk operation was cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("RustDesk operation was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForCredentialResolution(
  client: RustDeskBridgeClient,
  initialResult: unknown,
  context: {
    sessionID: string;
    abort: AbortSignal;
    metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
  },
): Promise<unknown> {
  let current = initialResult;
  let lastCredentialRequestId: string | undefined;
  const deadline = Date.now() + CREDENTIAL_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const connection = getConnection(current);
    if (!connection) return current;
    const status = typeof connection.status === "string" ? connection.status : undefined;
    const connectionId =
      typeof connection.connectionId === "string" ? connection.connectionId : undefined;

    if (status !== "credential_required") {
      if (lastCredentialRequestId) {
        context.metadata({
          title: "RustDesk credential resolved",
          metadata: {
            rustdeskSecureInput: {
              state: "resolved",
              credentialRequestId: lastCredentialRequestId,
              connectionId,
            },
          },
        });
      }
      return current;
    }

    const credentialRequestId =
      typeof connection.credentialRequestId === "string"
        ? connection.credentialRequestId
        : undefined;
    const credentialKind =
      typeof connection.credentialKind === "string" ? connection.credentialKind : undefined;

    if (!connectionId || !credentialRequestId) {
      throw new Error("RustDesk bridge returned an incomplete credential challenge");
    }

    if (credentialRequestId !== lastCredentialRequestId) {
      lastCredentialRequestId = credentialRequestId;
      context.metadata({
        title: "RustDesk credential required",
        metadata: {
          rustdeskSecureInput: {
            state: "required",
            credentialRequestId,
            credentialKind,
            connectionId,
          },
        },
      });
    }

    await sleepWithAbort(CONNECTION_POLL_INTERVAL_MS, context.abort);
    current = await client.execute({
      action: "connection.status",
      connectionId,
      sessionScope: context.sessionID,
    });
  }

  throw new Error("RustDesk credential input timed out");
}

function buildServerSelector(args: {
  server_kind?: string;
  server_profile_id?: string;
  id_server?: string;
  relay_server?: string;
  api_server?: string;
}): Record<string, unknown> | undefined {
  const rawKind = clean(args.server_kind);
  if (!rawKind) return undefined;
  const kind = rawKind.toLowerCase();
  if (!SERVER_KINDS.has(kind)) {
    throw new Error("server_kind must be public, saved-custom, or one-time-custom");
  }

  if (kind === "public") return { kind: "public" };
  if (kind === "saved-custom") {
    const serverProfileId = clean(args.server_profile_id);
    if (!serverProfileId) throw new Error("saved-custom server selection requires server_profile_id");
    return { kind, serverProfileId };
  }

  const idServer = clean(args.id_server);
  if (!idServer) throw new Error("one-time-custom server selection requires id_server");
  return {
    kind,
    idServer,
    relayServer: clean(args.relay_server),
    apiServer: clean(args.api_server),
  };
}

export default tool({
  description:
    "Control authorized remote devices through the RustDesk agent bridge. Permanent devices come from Settings > Integrations > RustDesk and resolve their saved server profile and permanent credential inside the trusted control plane. Temporary chat connections require an explicit RustDesk ID, connection server, and authentication mode. Use the question tool for non-sensitive choices and the permission flow for side effects. Never request or pass RustDesk passwords, 2FA codes, tokens, or private server keys through this tool; credential-required responses are completed through secure input outside model context.",
  args: {
    action: tool.schema.string().describe(
      "Action: bridge.health, servers.list, servers.get, servers.test, devices.list, devices.get, devices.connect, session.connectTemporary, connections.list, connection.status, connection.disconnect, terminal.open, terminal.write, terminal.read, terminal.resize, terminal.close, terminal.exec, screen.capture, mouse.move, mouse.click, mouse.doubleClick, mouse.drag, mouse.scroll, keyboard.type, keyboard.press, touch.tap, touch.longPress, touch.swipe, clipboard.read, clipboard.write, files.list, files.read, files.upload, files.download, system.info, system.restart.",
    ),
    device_id: tool.schema.string().optional().describe("Saved permanent integration device ID for devices.get/devices.connect."),
    connection_id: tool.schema.string().optional().describe("Live RustDesk connection ID returned by devices.connect or session.connectTemporary."),
    terminal_id: tool.schema.string().optional().describe("Interactive PTY ID for terminal.read/write/resize/close."),
    rustdesk_id: tool.schema.string().optional().describe("RustDesk peer ID for session.connectTemporary. This is an identifier, not a password."),
    server_kind: tool.schema
      .string()
      .optional()
      .describe("Connection server selection: public, saved-custom, or one-time-custom. Required for temporary connections."),
    server_profile_id: tool.schema
      .string()
      .optional()
      .describe("Saved RustDesk server profile ID for servers.get/servers.test or server_kind=saved-custom."),
    id_server: tool.schema.string().optional().describe("One-time custom RustDesk ID/rendezvous server host. Do not put keys/secrets here."),
    relay_server: tool.schema.string().optional().describe("Optional one-time custom RustDesk relay server host."),
    api_server: tool.schema.string().optional().describe("Optional one-time custom RustDesk API server host."),
    auth_mode: tool.schema
      .string()
      .optional()
      .describe("Temporary authentication mode: temporary-password, manual-approval, or password-or-approval."),
    command: tool.schema.string().optional().describe("Command for terminal.exec."),
    text: tool.schema.string().optional().describe("Text for keyboard.type, clipboard.write, or terminal.write."),
    keys: tool.schema.string().optional().describe("Keys for keyboard.press, separated by + or comma, for example CTRL+L or ALT,F4."),
    rows: tool.schema.number().optional().describe("PTY row count for terminal.open/terminal.resize."),
    cols: tool.schema.number().optional().describe("PTY column count for terminal.open/terminal.resize."),
    display_index: tool.schema.number().optional().describe("Display index for screen.capture where supported."),
    image_format: tool.schema.string().optional().describe("Screenshot format: png, jpeg, or webp."),
    quality: tool.schema.number().optional().describe("Optional bounded screenshot quality understood by the bridge."),
    max_bytes: tool.schema.number().optional().describe("Optional bounded maximum bytes for supported read operations."),
    path: tool.schema.string().optional().describe("Remote path for files.list/files.read."),
    local_path: tool.schema
      .string()
      .optional()
      .describe("Worktree-relative local path for files.upload/files.download. screen.capture may also write here."),
    remote_path: tool.schema.string().optional().describe("Remote path for files.upload/files.download."),
    x: tool.schema.number().optional().describe("X coordinate for pointer/touch actions."),
    y: tool.schema.number().optional().describe("Y coordinate for pointer/touch actions."),
    from_x: tool.schema.number().optional().describe("Start X coordinate for drag/swipe."),
    from_y: tool.schema.number().optional().describe("Start Y coordinate for drag/swipe."),
    to_x: tool.schema.number().optional().describe("End X coordinate for drag/swipe."),
    to_y: tool.schema.number().optional().describe("End Y coordinate for drag/swipe."),
    button: tool.schema.string().optional().describe("Mouse button: left, right, or middle."),
    delta_x: tool.schema.number().optional().describe("Horizontal scroll delta."),
    delta_y: tool.schema.number().optional().describe("Vertical scroll delta."),
    duration_ms: tool.schema.number().optional().describe("Duration for long press/swipe/drag where supported."),
    timeout_ms: tool.schema.number().optional().describe("Per-action bridge timeout, capped at 120000ms."),
  },
  async execute(args, context) {
    const action = args.action.trim();
    const base = context.directory || context.worktree || process.cwd();
    const downloadPath = action === "files.download" ? clean(args.local_path) : undefined;
    if (action === "files.download" && !downloadPath) {
      throw new Error("files.download requires local_path");
    }

    const server = buildServerSelector(args);
    const authMode = clean(args.auth_mode)?.toLowerCase();
    if (authMode && !TEMPORARY_AUTH_MODES.has(authMode)) {
      throw new Error("auth_mode must be temporary-password, manual-approval, or password-or-approval");
    }

    const imageFormat = clean(args.image_format)?.toLowerCase();
    if (imageFormat && !IMAGE_FORMATS.has(imageFormat)) {
      throw new Error("image_format must be png, jpeg, or webp");
    }

    const client = await getClient();
    const request: Record<string, unknown> = {
      action,
      deviceId: clean(args.device_id),
      connectionId: clean(args.connection_id),
      sessionScope: context.sessionID,
      terminalId: clean(args.terminal_id),
      rustdeskId: clean(args.rustdesk_id),
      serverProfileId: clean(args.server_profile_id),
      server,
      authMode,
      command: args.command,
      text: args.text,
      keys: parseKeys(args.keys),
      rows: args.rows,
      cols: args.cols,
      displayIndex: args.display_index,
      imageFormat,
      quality: args.quality,
      maxBytes: args.max_bytes,
      path: clean(args.path),
      remotePath: clean(args.remote_path),
      x: args.x,
      y: args.y,
      fromX: args.from_x,
      fromY: args.from_y,
      toX: args.to_x,
      toY: args.to_y,
      deltaX: args.delta_x,
      deltaY: args.delta_y,
      durationMs: args.duration_ms,
      timeoutMs: args.timeout_ms,
    };

    if (args.button) {
      const button = args.button.trim().toLowerCase();
      if (!BUTTONS.has(button)) throw new Error("button must be left, right, or middle");
      request.button = button;
    }

    if (action === "files.upload") {
      const localPath = clean(args.local_path);
      if (!localPath) throw new Error("files.upload requires local_path");
      const absolute = resolveInsideWorktree(base, localPath);
      const file = await fs.readFile(absolute);
      const maxBytes = maxTransferBytes();
      if (file.byteLength > maxBytes) {
        throw new Error(`Upload exceeds RUSTDESK_MAX_TRANSFER_BYTES (${maxBytes} bytes)`);
      }
      request.contentBase64 = file.toString("base64");
    }

    let result: unknown;
    try {
      result = await client.execute(request);
    } catch (error) {
      const permission = permissionErrorDetails(error);
      if (!permission) throw error;

      const pattern = permissionPattern(action, request);
      const approvalCorrelationId = randomBytes(24).toString("hex");
      await context.ask({
        permission: `rustdesk.${action}`,
        patterns: [pattern],
        always: [],
        metadata: {
          source: "rustdesk",
          action,
          risk: permission.risk,
          permission: permission.permission,
          connectionId: clean(args.connection_id),
          deviceId: clean(args.device_id),
          rustdeskId: clean(args.rustdesk_id),
          rustdeskApprovalCorrelationId: approvalCorrelationId,
        },
      });

      const grant = await (await getBridgeModule()).consumeRustDeskPermissionGrantHandoff({
        correlationId: approvalCorrelationId,
        action,
        connectionId: clean(args.connection_id),
        sessionScope: context.sessionID,
      });
      result = await client.execute({ ...request, permissionGrantId: grant.permissionGrantId });
    }

    if (getConnection(result)?.status === "credential_required") {
      result = await waitForCredentialResolution(client, result, context);
    }

    if (action === "screen.capture") {
      const imageBase64 = getBase64(result, "imageBase64");
      if (imageBase64) {
        const image = Buffer.from(imageBase64, "base64");
        const maxBytes = maxTransferBytes();
        if (image.byteLength > maxBytes) {
          throw new Error(`Screenshot exceeds RUSTDESK_MAX_TRANSFER_BYTES (${maxBytes} bytes)`);
        }
        const requestedPath = clean(args.local_path);
        const targetPart =
          clean(args.device_id)?.replace(/[^a-zA-Z0-9._-]+/g, "_") ||
          clean(args.connection_id)?.replace(/[^a-zA-Z0-9._-]+/g, "_") ||
          "device";
        const localPath = requestedPath ?? `.opencode/rustdesk/${targetPart}-screen-${Date.now()}${imageExtension(result)}`;
        const absolute = resolveInsideWorktree(base, localPath);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, image);
        return stringify({ ...resultWithoutBinary(result), localPath, bytes: image.byteLength });
      }
    }

    if (action === "files.download") {
      const contentBase64 = getBase64(result, "contentBase64");
      if (!contentBase64) throw new Error("RustDesk bridge did not return contentBase64 for files.download");
      const absolute = resolveInsideWorktree(base, downloadPath!);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      const file = Buffer.from(contentBase64, "base64");
      const maxBytes = maxTransferBytes();
      if (file.byteLength > maxBytes) {
        throw new Error(`Download exceeds RUSTDESK_MAX_TRANSFER_BYTES (${maxBytes} bytes)`);
      }
      await fs.writeFile(absolute, file);
      return stringify({ ...resultWithoutBinary(result), localPath: downloadPath, bytes: file.byteLength });
    }

    return stringify(result);
  },
});

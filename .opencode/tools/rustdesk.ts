import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

interface RustDeskBridgeClient {
  execute(request: Record<string, unknown>): Promise<unknown>;
}

interface RustDeskBridgeModule {
  createRustDeskBridgeClientFromEnv(): RustDeskBridgeClient;
}

const DEFAULT_SERVICE_PATH = "/app/dist/app/services/rustdesk-bridge-service.js";
const DEFAULT_MAX_TRANSFER_BYTES = 8 * 1024 * 1024;
const BUTTONS = new Set(["left", "right", "middle"]);

function servicePath(): string {
  return process.env.RUSTDESK_BRIDGE_SERVICE_PATH?.trim() || DEFAULT_SERVICE_PATH;
}

async function getClient(): Promise<RustDeskBridgeClient> {
  const module = (await import(pathToFileURL(servicePath()).href)) as RustDeskBridgeModule;
  return module.createRustDeskBridgeClientFromEnv();
}

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseKeys(value?: string): string[] | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const keys = raw.split(/[+,]/).map((key) => key.trim()).filter(Boolean);
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

export default tool({
  description:
    "Control authorized remote devices through the RustDesk agent bridge. Start with devices.list unless the target is already known, then choose actions from the device OS/capabilities. Prefer terminal actions for shellable work; use screen + mouse/keyboard/touch only when GUI interaction is actually needed. Supports terminals, screenshots, mouse, keyboard, touch, clipboard, files, device info, and restart. The bridge keeps RustDesk credentials; never ask users to paste device passwords into prompts.",
  args: {
    action: tool.schema.string().describe(
      "Action: bridge.health, devices.list, device.info, device.connect, device.disconnect, terminal.exec, terminal.open, terminal.write, terminal.read, terminal.close, screen.capture, mouse.move, mouse.click, mouse.doubleClick, mouse.drag, mouse.scroll, keyboard.type, keyboard.press, touch.tap, touch.longPress, touch.swipe, clipboard.read, clipboard.write, files.list, files.read, files.upload, files.download, system.info, system.restart.",
    ),
    device_id: tool.schema.string().optional().describe("Target RustDesk device ID. Not required for bridge.health or devices.list."),
    session_id: tool.schema.string().optional().describe("Terminal session ID for terminal.read/write/close."),
    command: tool.schema.string().optional().describe("Command for terminal.exec."),
    shell: tool.schema.string().optional().describe("Optional shell for terminal.open."),
    text: tool.schema.string().optional().describe("Text for keyboard.type, clipboard.write, or terminal.write."),
    keys: tool.schema.string().optional().describe("Keys for keyboard.press, separated by + or comma, for example CTRL+L or ALT,F4."),
    path: tool.schema.string().optional().describe("Remote path for files.list/files.read."),
    local_path: tool.schema.string().optional().describe("Worktree-relative local path for files.upload/files.download. screen.capture may also write here."),
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

    const client = await getClient();
    const request: Record<string, unknown> = {
      action,
      deviceId: clean(args.device_id),
      sessionId: clean(args.session_id),
      command: args.command,
      shell: clean(args.shell),
      text: args.text,
      keys: parseKeys(args.keys),
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

    const result = await client.execute(request);

    if (action === "screen.capture") {
      const imageBase64 = getBase64(result, "imageBase64");
      if (imageBase64) {
        const image = Buffer.from(imageBase64, "base64");
        const maxBytes = maxTransferBytes();
        if (image.byteLength > maxBytes) {
          throw new Error(`Screenshot exceeds RUSTDESK_MAX_TRANSFER_BYTES (${maxBytes} bytes)`);
        }
        const requestedPath = clean(args.local_path);
        const devicePart = clean(args.device_id)?.replace(/[^a-zA-Z0-9._-]+/g, "_") || "device";
        const localPath = requestedPath ?? `.opencode/rustdesk/${devicePart}-screen-${Date.now()}${imageExtension(result)}`;
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

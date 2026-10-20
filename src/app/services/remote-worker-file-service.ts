import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeBindings, type NodeBinding } from "../../control-plane/node-bindings.js";
import { requestNodeLifecycle } from "../../control-plane/application-transport.js";

export const REMOTE_WORKER_FILE_LIMIT = 50 * 1024 * 1024;
const REMOTE_FILE_CHUNK_BYTES = 2 * 1024 * 1024;

export interface RemoteWorkerFileInfo {
  name: string;
  path: string;
  absolutePath?: string;
  size: number;
  mtimeMs: number;
  isFile: true;
}

export interface RemoteWorkerFileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number | null;
  mtimeMs?: number | null;
}

export async function resolveReadyTopicWorker(
  chatId: number,
  threadId: number,
  expectedSessionId?: string,
): Promise<NodeBinding | null> {
  const binding = await nodeBindings.find(chatId, threadId);
  if (!binding) return null;
  if (binding.status !== "ready" || !binding.sessionId || (expectedSessionId && binding.sessionId !== expectedSessionId)) {
    throw new Error("The current Topic Worker is not ready for file operations.");
  }
  return binding;
}

function assertCurrent(binding: NodeBinding): Promise<void> {
  return nodeBindings.find(binding.chatId, binding.threadId).then((current) => {
    if (!current || current.status !== "ready" || current.nodeId !== binding.nodeId ||
      current.generation !== binding.generation || current.sessionId !== binding.sessionId) {
      throw new Error("Topic Worker changed during file operation.");
    }
  });
}

async function request<T>(binding: NodeBinding, operation: "file.list" | "file.read" | "file.stat" | "file.download", payload: Record<string, unknown>): Promise<T> {
  await assertCurrent(binding);
  const response = await requestNodeLifecycle(binding, operation, payload);
  await assertCurrent(binding);
  if (!response || response.ok !== true) throw new Error(`Worker ${operation} request failed.`);
  return response.result as T;
}

export function normalizeRemoteRelativePath(value: string): string {
  const clean = value.trim().replaceAll("\\", "/");
  if (!clean || clean.startsWith("/") || clean.includes("\0") || clean.split("/").some((part) => part === "..")) {
    throw new Error("Remote workspace path must be relative and stay inside the current Topic workspace.");
  }
  return clean.replace(/^\.\//u, "") || ".";
}

export async function listRemoteWorkerFiles(binding: NodeBinding, rawPath = "."): Promise<RemoteWorkerFileEntry[]> {
  const workspacePath = normalizeRemoteRelativePath(rawPath);
  const entries = await request<unknown>(binding, "file.list", { path: workspacePath });
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error("Worker returned an invalid directory listing.");
  return entries.filter((item): item is RemoteWorkerFileEntry => Boolean(item && typeof item === "object" &&
    typeof (item as RemoteWorkerFileEntry).name === "string" && typeof (item as RemoteWorkerFileEntry).path === "string" &&
    ((item as RemoteWorkerFileEntry).type === "file" || (item as RemoteWorkerFileEntry).type === "directory")));
}

export async function statRemoteWorkerFile(binding: NodeBinding, rawPath: string): Promise<RemoteWorkerFileInfo> {
  const value = rawPath.startsWith("/") ? rawPath : normalizeRemoteRelativePath(rawPath);
  const info = await request<RemoteWorkerFileInfo>(binding, "file.stat", { path: value });
  if (!info || info.isFile !== true || typeof info.name !== "string" || typeof info.path !== "string" ||
    !Number.isSafeInteger(info.size) || info.size < 0 || info.size > REMOTE_WORKER_FILE_LIMIT || !Number.isFinite(info.mtimeMs)) {
    throw new Error("Worker returned invalid file metadata.");
  }
  return info;
}

export async function readRemoteWorkerText(binding: NodeBinding, rawPath: string, maxBytes = 256 * 1024): Promise<{ name: string; mimeType: string; dataUri: string }> {
  const info = await statRemoteWorkerFile(binding, rawPath);
  if (info.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte text attachment limit.`);
  const value = rawPath.startsWith("/") ? rawPath : normalizeRemoteRelativePath(rawPath);
  const content = await request<unknown>(binding, "file.read", { path: value });
  if (!content || typeof content !== "object" || (content as { type?: unknown }).type !== "text" || typeof (content as { content?: unknown }).content !== "string") {
    throw new Error("This file is binary or is not valid UTF-8 text; it cannot be attached as a text prompt.");
  }
  const text = (content as { content: string }).content;
  return { name: info.name, mimeType: "text/plain", dataUri: `data:text/plain;base64,${Buffer.from(text, "utf8").toString("base64")}` };
}

export async function readRemoteWorkerFilePrefix(binding: NodeBinding, rawPath: string, maximum = 4096): Promise<Buffer> {
  const info = await statRemoteWorkerFile(binding, rawPath);
  const limit = Math.max(1, Math.min(Math.trunc(maximum), REMOTE_FILE_CHUNK_BYTES));
  if (info.size === 0) return Buffer.alloc(0);
  const remotePath = rawPath.startsWith("/") ? rawPath : normalizeRemoteRelativePath(rawPath);
  const chunk = await request<{ path: string; size: number; offset: number; nextOffset: number; eof: boolean; data: string }>(
    binding, "file.download", { path: remotePath, offset: 0, limit },
  );
  if (!chunk || chunk.path !== info.path || chunk.size !== info.size || chunk.offset !== 0 || typeof chunk.data !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(chunk.data)) {
    throw new Error("Worker file prefix returned an invalid chunk.");
  }
  const bytes = Buffer.from(chunk.data, "base64");
  if (bytes.length > limit || chunk.nextOffset !== bytes.length || chunk.eof !== (bytes.length >= info.size)) {
    throw new Error("Worker file prefix bounds are invalid.");
  }
  return bytes;
}

export async function downloadRemoteWorkerFile(binding: NodeBinding, rawPath: string): Promise<{ path: string; name: string; size: number; mtimeMs: number; cleanup: () => Promise<void> }> {
  const info = await statRemoteWorkerFile(binding, rawPath);
  if (info.size <= 0) throw new Error("Refusing to transfer an empty file.");
  const remotePath = rawPath.startsWith("/") ? rawPath : normalizeRemoteRelativePath(rawPath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-telegram-worker-file-"));
  const safeName = path.basename(info.name).replace(/[^a-zA-Z0-9._-]/gu, "_") || "worker-file.bin";
  const destination = path.join(directory, safeName);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(destination, "wx", 0o600);
    let offset = 0;
    while (offset < info.size) {
      const chunk = await request<{ path: string; size: number; offset: number; nextOffset: number; eof: boolean; data: string }>(
        binding, "file.download", { path: remotePath, offset, limit: REMOTE_FILE_CHUNK_BYTES },
      );
      if (!chunk || chunk.path !== info.path || chunk.size !== info.size || chunk.offset !== offset ||
        typeof chunk.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(chunk.data)) {
        throw new Error("Worker file transfer returned an invalid chunk.");
      }
      const bytes = Buffer.from(chunk.data, "base64");
      if (!bytes.length || bytes.length > REMOTE_FILE_CHUNK_BYTES || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > info.size || chunk.eof !== (chunk.nextOffset >= info.size)) {
        throw new Error("Worker file transfer chunk bounds are invalid.");
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, offset + written);
        if (result.bytesWritten <= 0) throw new Error("Could not persist Worker file chunk.");
        written += result.bytesWritten;
      }
      offset = chunk.nextOffset;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertCurrent(binding);
    const localStat = await fs.stat(destination);
    if (!localStat.isFile() || localStat.size !== info.size) throw new Error("Worker file transfer size verification failed.");
    return { path: destination, name: safeName, size: info.size, mtimeMs: info.mtimeMs, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

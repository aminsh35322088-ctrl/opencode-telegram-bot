import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function assertHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) downloads are allowed.");
  }
  return url;
}

export default tool({
  description:
    "Download a remote HTTP(S) file into the current worktree with a hard 50 MB size limit. Use this instead of raw download commands. The tool refuses larger Content-Length values and aborts streaming downloads that exceed the limit.",
  args: {
    url: tool.schema.string().describe("HTTP(S) URL of the file to download."),
    filename: tool.schema.string().describe("Destination filename/path relative to the current worktree."),
    timeoutMs: tool.schema.number().optional().describe("Timeout in milliseconds, default 120000."),
  },
  async execute(args, context) {
    const url = assertHttpUrl(args.url);
    const destination = path.resolve(context.worktree, args.filename);
    const relative = path.relative(context.worktree, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Download destination must stay inside the current worktree.");
    }

    const timeout = Math.max(5_000, Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 300_000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "OpenCode-Agent/1.0" },
      });

      if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status} ${response.statusText}.`);
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
        throw new Error("Download refused: remote file is larger than the 50 MB agent download limit.");
      }

      if (!response.body) {
        throw new Error("Download failed: response has no body.");
      }

      await fs.mkdir(path.dirname(destination), { recursive: true });
      const tempPath = `${destination}.part`;
      await fs.rm(tempPath, { force: true });

      const file = await fs.open(tempPath, "w");
      let total = 0;
      try {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_DOWNLOAD_BYTES) {
              throw new Error("Download refused: file exceeded the 50 MB agent download limit.");
            }
            await file.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      } finally {
        await file.close();
      }

      await fs.rename(tempPath, destination);
      return JSON.stringify({
        url: url.toString(),
        path: destination,
        bytes: total,
        limitBytes: MAX_DOWNLOAD_BYTES,
      }, null, 2);
    } catch (error) {
      await fs.rm(`${destination}.part`, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
});

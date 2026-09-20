import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";

type ApiResponse<T> = { data?: T; error?: unknown };
type SessionRecord = { id?: string; title?: string; directory?: string; time?: { created?: number } };
type SessionMessage = {
  info?: { role?: string; time?: { created?: number } };
  parts?: Array<{ type?: string; text?: string }>;
};

interface OpenCodeClientModule {
  opencodeClient: {
    session: {
      create(input: Record<string, unknown>): Promise<ApiResponse<SessionRecord>>;
      delete(input: Record<string, unknown>): Promise<ApiResponse<boolean>>;
      list(input: Record<string, unknown>): Promise<ApiResponse<SessionRecord[]>>;
      messages(input: Record<string, unknown>): Promise<ApiResponse<SessionMessage[]>>;
    };
  };
}

async function loadClient() {
  return import(pathToFileURL(path.join(DIST_ROOT, "opencode/client.js")).href) as Promise<OpenCodeClientModule>;
}

function unwrap<T>(response: ApiResponse<T>, label: string): T {
  if (response.error) throw response.error;
  if (response.data === undefined) throw new Error(`${label} returned no data.`);
  return response.data;
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 120);
}

function messageText(message: SessionMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function toMarkdown(messages: SessionMessage[]): string {
  return messages.map((message) => {
    const role = message.info?.role || "unknown";
    const created = message.info?.time?.created;
    const timestamp = typeof created === "number" ? new Date(created).toISOString() : "";
    return `## ${role}${timestamp ? ` (${timestamp})` : ""}\n\n${messageText(message) || "_No text content_"}`;
  }).join("\n\n---\n\n");
}

export default tool({
  description: "Extended OpenCode session operations for the current directory: create, delete, export, list-all, and archive. Creating a session does not rebind the current Telegram Topic.",
  args: {
    action: tool.schema.enum(["create", "delete", "export", "list-all", "archive"]).describe("Session action to execute."),
    session_id: tool.schema.string().optional().describe("Session ID required for delete/export/archive."),
    format: tool.schema.enum(["json", "markdown"]).optional().describe("Export format; defaults to markdown."),
    title: tool.schema.string().optional().describe("Optional title for create."),
  },
  async execute(args, context) {
    const client = (await loadClient()).opencodeClient;
    const directory = context.directory || context.worktree;

    if (args.action === "create") {
      const title = args.title?.trim();
      const result = unwrap(await client.session.create({
        directory,
        ...(title ? { title } : {}),
      }), "session.create");
      return JSON.stringify({ ok: true, session: result, note: "Telegram Topic binding was not changed." }, null, 2);
    }

    if (args.action === "list-all") {
      const sessions = unwrap(await client.session.list({ directory }), "session.list");
      return JSON.stringify(sessions, null, 2).slice(0, 30000);
    }

    const sessionId = required(args.session_id, "session_id");

    if (args.action === "delete") {
      if (sessionId === context.sessionID) {
        throw new Error("Refusing to delete the currently executing session. Switch/fork first, then delete the old session.");
      }
      const deleted = unwrap(await client.session.delete({ sessionID: sessionId, directory }), "session.delete");
      return JSON.stringify({ ok: Boolean(deleted), sessionId }, null, 2);
    }

    const messages = unwrap(await client.session.messages({ sessionID: sessionId, directory }), "session.messages");
    const exportRoot = args.action === "archive"
      ? path.join(context.worktree, ".archive", "sessions")
      : context.worktree;
    await fs.mkdir(exportRoot, { recursive: true });

    const format = args.action === "archive" ? "json" : (args.format ?? "markdown");
    const extension = format === "json" ? "json" : "md";
    const prefix = args.action === "archive" ? "session" : "session-export";
    const output = path.join(exportRoot, `${prefix}-${safeFilePart(sessionId)}.${extension}`);
    const payload = format === "json" ? JSON.stringify(messages, null, 2) : toMarkdown(messages);
    await fs.writeFile(output, payload, "utf8");

    return JSON.stringify({
      ok: true,
      sessionId,
      format,
      messageCount: messages.length,
      path: output,
    }, null, 2);
  },
});

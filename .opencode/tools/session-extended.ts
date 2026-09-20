import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Extended session operations: create, delete, export, list-all, archive. Works with OpenCode session API.",
  args: {
    action: tool.schema.enum(["create", "delete", "export", "list-all", "archive"]).describe("Session action to execute."),
    session_id: tool.schema.string().optional().describe("Session ID (required for delete, export, archive)."),
    format: tool.schema.string().optional().describe("Export format: json or markdown (for export action)."),
  },
  async execute(args, context) {
    const { action, session_id, format } = args;
    const apiBase = process.env.OPENCODE_API_URL || "http://localhost:4096";

    async function apiCall(endpoint: string, method = "GET", body?: unknown): Promise<unknown> {
      const response = await fetch(`${apiBase}${endpoint}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const error = await response.text().catch(() => "");
        throw new Error(`API error ${response.status}: ${error || response.statusText}`);
      }
      return response.json();
    }

    switch (action) {
      case "create": {
        const result = await apiCall("/session/create", "POST", {
          topicId: context.topicId,
        }) as { id: string };
        return `Session created: ${result.id}`;
      }
      case "delete": {
        if (!session_id) throw new Error("session_id required for delete");
        await apiCall(`/session/${session_id}`, "DELETE");
        return `Session ${session_id} deleted`;
      }
      case "export": {
        if (!session_id) throw new Error("session_id required for export");
        const messages = await apiCall(`/session/${session_id}/messages`) as Array<{
          role: string;
          content: string;
          timestamp?: string;
        }>;

        if (format === "json") {
          const exportPath = path.join(context.worktree, `session-${session_id}.json`);
          await fs.writeFile(exportPath, JSON.stringify(messages, null, 2));
          return `Exported to ${exportPath}`;
        }

        const md = messages.map((m) => {
          const header = `## ${m.role}${m.timestamp ? ` (${m.timestamp})` : ""}`;
          return `${header}\n\n${m.content}`;
        }).join("\n\n---\n\n");
        const exportPath = path.join(context.worktree, `session-${session_id}.md`);
        await fs.writeFile(exportPath, md);
        return `Exported to ${exportPath}`;
      }
      case "list-all": {
        const sessions = await apiCall("/session/list") as Array<{
          id: string;
          topicId?: string;
          createdAt?: string;
        }>;
        if (!sessions.length) return "No sessions found";
        return sessions.map((s) => `${s.id} | topic: ${s.topicId || "N/A"} | created: ${s.createdAt || "N/A"}`).join("\n");
      }
      case "archive": {
        if (!session_id) throw new Error("session_id required for archive");
        const archiveDir = path.join(context.worktree, ".archive");
        await fs.mkdir(archiveDir, { recursive: true });
        const messages = await apiCall(`/session/${session_id}/messages`);
        const archivePath = path.join(archiveDir, `session-${session_id}.json`);
        await fs.writeFile(archivePath, JSON.stringify(messages, null, 2));
        return `Archived session ${session_id} to ${archivePath}`;
      }
      default:
        throw new Error(`Unknown session action: ${action}`);
    }
  },
});

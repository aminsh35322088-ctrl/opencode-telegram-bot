import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const ACTIONS = ["current", "messages", "latest-assistant", "fork", "revert", "unrevert", "summarize", "abort", "diff", "todo", "children"] as const;
type SessionAction = (typeof ACTIONS)[number];
const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";

interface MessageModule {
  loadUserMessages(sessionID: string, directory: string): Promise<unknown>;
  loadLatestAssistantResponse(sessionID: string, directory: string): Promise<string>;
}
interface SessionAutonomyModule {
  listSessionTodos(scope?: { sessionID: string; directory: string }): Promise<unknown>;
  listSessionDiff(scope?: { sessionID: string; directory: string }): Promise<unknown>;
  listSessionChildren(scope?: { sessionID: string; directory: string }): Promise<unknown>;
  forkCurrentSession(messageID: string, scope?: { sessionID: string; directory: string }): Promise<unknown>;
  revertCurrentSession(messageID: string, scope?: { sessionID: string; directory: string }): Promise<unknown>;
  unrevertCurrentSession(scope?: { sessionID: string; directory: string }): Promise<unknown>;
  summarizeCurrentSession(scope?: { sessionID: string; directory: string }): Promise<unknown>;
  abortCurrentSession(scope?: { sessionID: string; directory: string }): Promise<unknown>;
}
async function load<T>(relative: string): Promise<T> { return import(pathToFileURL(path.join(DIST_ROOT, relative)).href) as Promise<T>; }
function required(value: string | undefined, field: string, action: SessionAction): string { const v=value?.trim(); if(!v) throw new Error(`${action} requires ${field}`); return v; }
function json(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 30000); }

export default tool({
  description: "Inspect and control the current OpenCode session. Revert/abort are destructive; fork creates a new session but does not silently switch the Telegram Topic binding.",
  args: {
    action: tool.schema.enum(ACTIONS).describe("Session action to execute."),
    message_id: tool.schema.string().optional().describe("OpenCode message ID required by fork/revert."),
  },
  async execute(args, context) {
    const action = args.action as SessionAction;
    const scope = { sessionID: context.sessionID, directory: context.directory };
    if (action === "current") return json({ id: context.sessionID, directory: context.directory, worktree: context.worktree, messageID: context.messageID, agent: context.agent });
    if (action === "messages" || action === "latest-assistant") {
      const messages = await load<MessageModule>("app/services/message-history-service.js");
      return action === "messages" ? json(await messages.loadUserMessages(context.sessionID, context.directory)) : json({ text: await messages.loadLatestAssistantResponse(context.sessionID, context.directory) });
    }
    const autonomy = await load<SessionAutonomyModule>("app/services/session-autonomy-service.js");
    if (action === "todo") return json(await autonomy.listSessionTodos(scope));
    if (action === "diff") return json(await autonomy.listSessionDiff(scope));
    if (action === "children") return json(await autonomy.listSessionChildren(scope));
    if (action === "fork") return json(await autonomy.forkCurrentSession(required(args.message_id, "message_id", action), scope));
    if (action === "revert") return json(await autonomy.revertCurrentSession(required(args.message_id, "message_id", action), scope));
    if (action === "unrevert") return json(await autonomy.unrevertCurrentSession(scope));
    if (action === "summarize") return json(await autonomy.summarizeCurrentSession(scope));
    return json(await autonomy.abortCurrentSession(scope));
  },
});
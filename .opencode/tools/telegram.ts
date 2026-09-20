import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const ACTIONS = ["context.current", "reply.resolve", "forward.inspect", "media.fetch"] as const;
type TelegramAction = (typeof ACTIONS)[number];
const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";
interface ContextModule {
  getTelegramMessageContext(worktree: string, sessionId?: string): Promise<any>;
  fetchTelegramContextMedia(worktree: string, input: { target?: "current" | "reply"; index?: number; output?: string }, sessionId?: string): Promise<any>;
}
async function load(): Promise<ContextModule> { return import(pathToFileURL(path.join(DIST_ROOT, "app/services/telegram-message-context-service.js")).href) as Promise<ContextModule>; }
function json(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 30000); }

export default tool({
  description: "Read the current AI Topic's persisted Telegram message/reply/forward context or fetch media belonging to that context into the current worktree. Arbitrary Telegram links/messages are not resolved.",
  args: {
    action: tool.schema.enum(ACTIONS).describe("Telegram context action."),
    target: tool.schema.enum(["current", "reply"]).optional().describe("For media.fetch: which message owns the media."),
    media_index: tool.schema.number().optional().describe("For media.fetch: zero-based media index, default 0."),
    output: tool.schema.string().optional().describe("For media.fetch: worktree-relative output path."),
  },
  async execute(args, context) {
    const action = args.action as TelegramAction; const base = context.directory || context.worktree || process.cwd();
    const service = await load();
    const snapshot = await service.getTelegramMessageContext(base, context.sessionID);
    if (action === "context.current") return json(snapshot);
    if (!snapshot) return json({ ok: false, error: "No Telegram message context is available for this worktree." });
    if (action === "reply.resolve") return json(snapshot.message?.reply ?? null);
    if (action === "forward.inspect") return json(snapshot.message?.forward ?? null);
    return json(await service.fetchTelegramContextMedia(base, { target: args.target as "current" | "reply" | undefined, index: args.media_index, output: args.output }, context.sessionID));
  },
});
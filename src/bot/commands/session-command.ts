import type { CommandContext, Context } from "grammy";
import { getCurrentSession } from "../../app/services/session-service.js";
import { opencodeClient } from "../../opencode/client.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

interface SessionStatusLike {
  type?: string;
  attempt?: number;
  message?: string;
}

interface SessionTodoLike {
  content?: string;
  status?: string;
  priority?: string;
}

interface SessionDiffLike {
  file?: string;
  additions?: number;
  deletions?: number;
}

interface ChildSessionLike {
  id?: string;
  title?: string;
}

const MAX_TODO_ITEMS = 5;
const MAX_DIFF_FILES = 8;
const MAX_CHILDREN = 5;
const MAX_ITEM_TEXT = 120;

function truncateInline(value: string, maxLength = MAX_ITEM_TEXT): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

async function loadCapability<T>(
  label: string,
  request: Promise<{ data?: T; error?: unknown }>,
): Promise<T | null> {
  try {
    const result = await request;
    if (result.error || result.data === undefined) {
      logger.warn(`[SessionDashboard] OpenCode ${label} unavailable:`, result.error);
      return null;
    }
    return result.data;
  } catch (error) {
    logger.warn(`[SessionDashboard] OpenCode ${label} request failed:`, error);
    return null;
  }
}

function formatStatus(status: SessionStatusLike | undefined): string {
  if (!status?.type) return t("session.status_unknown");
  if (status.type === "idle") return t("session.status_idle");
  if (status.type === "busy") return t("session.status_busy");
  if (status.type === "retry") {
    const attempt = typeof status.attempt === "number" ? ` · attempt ${status.attempt}` : "";
    const message = status.message ? ` · ${truncateInline(status.message, 80)}` : "";
    return `${t("session.status_retry")}${attempt}${message}`;
  }
  return `⚪ ${truncateInline(status.type, 40)}`;
}

function todoIcon(status: string | undefined): string {
  if (status === "completed") return "✅";
  if (status === "in_progress") return "🔄";
  if (status === "cancelled") return "🚫";
  return "⏳";
}

function formatTodoSection(todos: SessionTodoLike[] | null): string[] {
  if (todos === null) return [t("session.todos_unavailable")];
  if (todos.length === 0) return [t("session.todos_none")];

  const active = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const lines = [t("session.todos_summary", { total: todos.length, active: active.length, done: completed })];

  const visible = active.length > 0 ? active : todos;
  for (const todo of visible.slice(0, MAX_TODO_ITEMS)) {
    const priority = todo.priority ? ` [${truncateInline(todo.priority, 16)}]` : "";
    const content = truncateInline(todo.content || "Untitled task");
    lines.push(`${todoIcon(todo.status)}${priority} ${content}`);
  }
  if (visible.length > MAX_TODO_ITEMS) lines.push(t("session.more", { count: visible.length - MAX_TODO_ITEMS }));
  return lines;
}

function formatDiffSection(diffs: SessionDiffLike[] | null): string[] {
  if (diffs === null) return [t("session.changes_unavailable")];
  if (diffs.length === 0) return [t("session.changes_none")];

  const additions = diffs.reduce((sum, diff) => sum + (Number.isFinite(diff.additions) ? diff.additions! : 0), 0);
  const deletions = diffs.reduce((sum, diff) => sum + (Number.isFinite(diff.deletions) ? diff.deletions! : 0), 0);
  const lines = [t("session.changes_summary", { files: diffs.length, additions, deletions })];
  for (const diff of diffs.slice(0, MAX_DIFF_FILES)) {
    lines.push(`• ${truncateInline(diff.file || "unknown file")}`);
  }
  if (diffs.length > MAX_DIFF_FILES) lines.push(t("session.more", { count: diffs.length - MAX_DIFF_FILES }));
  return lines;
}

function formatChildrenSection(children: ChildSessionLike[] | null): string[] {
  if (children === null) return [t("session.children_unavailable")];
  if (children.length === 0) return [t("session.children_none")];

  const lines = [t("session.children_summary", { count: children.length })];
  for (const child of children.slice(0, MAX_CHILDREN)) {
    lines.push(`• ${truncateInline(child.title || child.id || "Untitled child session")}`);
  }
  if (children.length > MAX_CHILDREN) lines.push(t("session.more", { count: children.length - MAX_CHILDREN }));
  return lines;
}

export async function sessionCommand(ctx: CommandContext<Context>): Promise<void> {
  const session = getCurrentSession();
  if (!session) {
    await ctx.reply(t("session.no_session"));
    return;
  }

  const scope = { directory: session.directory };
  const [statuses, todos, diffs, children] = await Promise.all([
    loadCapability<Record<string, SessionStatusLike>>(
      "session status",
      opencodeClient.session.status(scope),
    ),
    loadCapability<SessionTodoLike[]>(
      "session todos",
      opencodeClient.session.todo({ sessionID: session.id, ...scope }),
    ),
    loadCapability<SessionDiffLike[]>(
      "session diff",
      opencodeClient.session.diff({ sessionID: session.id, ...scope }),
    ),
    loadCapability<ChildSessionLike[]>(
      "session children",
      opencodeClient.session.children({ sessionID: session.id, ...scope }),
    ),
  ]);

  const status = statuses?.[session.id];
  const lines = [
    t("session.header"),
    truncateInline(session.title || session.id, 160),
    t("session.state", { status: formatStatus(status) }),
    "",
    ...formatTodoSection(todos),
    "",
    ...formatDiffSection(diffs),
    "",
    ...formatChildrenSection(children),
  ];

  await ctx.reply(lines.join("\n"));
}

import { InlineKeyboard } from "grammy";
import { t } from "../../i18n/index.js";

export const SESSION_DASHBOARD_MESSAGES = "session-dashboard:messages";
export const SESSION_DASHBOARD_TODOS = "session-dashboard:todos";
export const SESSION_DASHBOARD_DIFF = "session-dashboard:diff";
export const SESSION_DASHBOARD_CHILDREN = "session-dashboard:children";
export const SESSION_DASHBOARD_FILES = "session-dashboard:files";
export const SESSION_DASHBOARD_RENAME = "session-dashboard:rename";
export const SESSION_DASHBOARD_SETTINGS = "session-dashboard:settings";

export interface SessionDashboardTodo {
  content?: string;
  status?: string;
  priority?: string;
}
export interface SessionDashboardDiff {
  path?: string;
  file?: string;
  additions?: number;
  deletions?: number;
}
export interface SessionDashboardChild {
  id?: string;
  title?: string;
}
export interface SessionDashboardState {
  sessionId: string;
  title?: string;
  model?: string;
  busy?: boolean;
  todos?: SessionDashboardTodo[] | null;
  diffs?: SessionDashboardDiff[] | null;
  children?: SessionDashboardChild[] | null;
}

const inline = (value: unknown, max = 120): string => {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};
const todoIcon = (status: string | undefined): string =>
  status === "completed" ? "✅" : status === "in_progress" ? "🔄" : status === "cancelled" ? "🚫" : "⏳";

function todoLines(items: SessionDashboardTodo[] | null | undefined): string[] {
  if (items == null) return [t("session.todos_unavailable")];
  if (!items.length) return [t("session.todos_none")];
  const active = items.filter((item) => item.status !== "completed" && item.status !== "cancelled");
  const done = items.filter((item) => item.status === "completed").length;
  const visible = active.length ? active : items;
  return [
    t("session.todos_summary", { total: items.length, active: active.length, done }),
    ...visible.slice(0, 5).map((item) => `${todoIcon(item.status)} ${inline(item.content || "Untitled task")}`),
    ...(visible.length > 5 ? [t("session.more", { count: visible.length - 5 })] : []),
  ];
}

function diffLines(items: SessionDashboardDiff[] | null | undefined): string[] {
  if (items == null) return [t("session.changes_unavailable")];
  if (!items.length) return [t("session.changes_none")];
  const additions = items.reduce((sum, item) => sum + (Number.isFinite(item.additions) ? Number(item.additions) : 0), 0);
  const deletions = items.reduce((sum, item) => sum + (Number.isFinite(item.deletions) ? Number(item.deletions) : 0), 0);
  return [
    t("session.changes_summary", { files: items.length, additions, deletions }),
    ...items.slice(0, 8).map((item) => `• ${inline(item.path ?? item.file ?? "unknown file")}`),
    ...(items.length > 8 ? [t("session.more", { count: items.length - 8 })] : []),
  ];
}

function childLines(items: SessionDashboardChild[] | null | undefined): string[] {
  if (items == null) return [t("session.children_unavailable")];
  if (!items.length) return [t("session.children_none")];
  return [
    t("session.children_summary", { count: items.length }),
    ...items.slice(0, 5).map((item) => `• ${inline(item.title ?? item.id ?? "Untitled child session")}`),
    ...(items.length > 5 ? [t("session.more", { count: items.length - 5 })] : []),
  ];
}

export function buildSessionDashboardView(state: SessionDashboardState): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard()
    .text("🕘 Messages", SESSION_DASHBOARD_MESSAGES).row()
    .text("☑ Tasks", SESSION_DASHBOARD_TODOS)
    .text("📝 Changes", SESSION_DASHBOARD_DIFF).row()
    .text("🤖 Sub-agents", SESSION_DASHBOARD_CHILDREN)
    .text("📁 Files", SESSION_DASHBOARD_FILES).row()
    .text("🏷 Rename", SESSION_DASHBOARD_RENAME).row()
    .text("← Topic Settings", SESSION_DASHBOARD_SETTINGS);
  return {
    text: [
      t("session.header"),
      inline(state.title || state.sessionId, 160),
      t("session.state", { status: state.busy ? t("session.status_busy") : t("session.status_idle") }),
      ...(state.model ? [`Model: ${inline(state.model, 160)}`] : []),
      "",
      ...todoLines(state.todos),
      "",
      ...diffLines(state.diffs),
      "",
      ...childLines(state.children),
    ].join("\n"),
    keyboard,
  };
}

export const SESSION_DASHBOARD_CHILD_PREFIX = "session-dashboard:child:";

export function buildSessionTodosView(items: SessionDashboardTodo[] | null | undefined): { text: string; keyboard: InlineKeyboard } {
  return {
    text: ["☑ <b>Tasks</b>", "", ...todoLines(items)].join("\n"),
    keyboard: new InlineKeyboard().text("← Session", "session:back"),
  };
}

export function buildSessionDiffView(items: SessionDashboardDiff[] | null | undefined): { text: string; keyboard: InlineKeyboard } {
  return {
    text: ["📝 <b>Changes</b>", "", ...diffLines(items)].join("\n"),
    keyboard: new InlineKeyboard().text("← Session", "session:back"),
  };
}

export function buildSessionChildrenView(items: SessionDashboardChild[] | null | undefined): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  for (const child of (items ?? []).slice(0, 30)) {
    const id = String(child.id ?? "").trim();
    if (!id) continue;
    keyboard.text(`🤖 ${inline(child.title ?? id, 58)}`, SESSION_DASHBOARD_CHILD_PREFIX + id).row();
  }
  keyboard.text("← Session", "session:back");
  return {
    text: ["🤖 <b>Sub-agents</b>", "", ...childLines(items)].join("\n"),
    keyboard,
  };
}

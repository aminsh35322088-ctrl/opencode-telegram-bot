import { InlineKeyboard } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getDateLocale, t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

export const SESSION_CALLBACK_PREFIX = "session:";
export const SESSION_PREVIEW_CALLBACK_PREFIX = "session:preview:";
export const SESSION_CONTINUE_CALLBACK_PREFIX = "session:continue:";
export const SESSION_BACK_CALLBACK = "session:back";
export const SESSION_NO_CALLBACK = "session:no";
const SESSION_PAGE_CALLBACK_PREFIX = "session:page:";
const BACKGROUND_SESSION_CALLBACK_PREFIX = "background-session:";
const SESSION_FETCH_EXTRA_COUNT = 1;
const SESSION_BUTTON_MAX_LENGTH = 58;

export type SessionListItem = { id: string; title: string; directory: string; time: { created: number } };
export type SessionPage = { sessions: SessionListItem[]; hasNext: boolean; page: number };
export type BackgroundSessionOpenKind = "assistant_response" | "question_asked" | "permission_asked";
export interface BackgroundSessionCallbackPayload { sessionId: string; kind: BackgroundSessionOpenKind | null; }

const BACKGROUND_SESSION_KIND_CALLBACK_MARKERS: Record<BackgroundSessionOpenKind, string> = { assistant_response: "a", question_asked: "q", permission_asked: "p" };
const BACKGROUND_SESSION_KIND_BY_CALLBACK_MARKER: Record<string, BackgroundSessionOpenKind> = { a: "assistant_response", q: "question_asked", p: "permission_asked" };

function buildSessionPageCallback(page: number): string { return `${SESSION_PAGE_CALLBACK_PREFIX}${page}`; }
export function buildSessionPreviewCallback(sessionId: string): string { return `${SESSION_PREVIEW_CALLBACK_PREFIX}${sessionId}`; }
export function buildSessionContinueCallback(sessionId: string): string { return `${SESSION_CONTINUE_CALLBACK_PREFIX}${sessionId}`; }

export function parseSessionPageCallback(data: string): number | null {
  if (!data.startsWith(SESSION_PAGE_CALLBACK_PREFIX)) return null;
  const page = Number(data.slice(SESSION_PAGE_CALLBACK_PREFIX.length));
  return Number.isInteger(page) && page >= 0 ? page : null;
}

export function parseSessionIdCallback(data: string): string | null {
  if (!data.startsWith(SESSION_CALLBACK_PREFIX) || data.startsWith(SESSION_PAGE_CALLBACK_PREFIX) || data.startsWith(SESSION_PREVIEW_CALLBACK_PREFIX) || data.startsWith(SESSION_CONTINUE_CALLBACK_PREFIX)) return null;
  const sessionId = data.slice(SESSION_CALLBACK_PREFIX.length);
  return sessionId.length > 0 && data !== SESSION_BACK_CALLBACK && data !== SESSION_NO_CALLBACK ? sessionId : null;
}

export function parseSessionPreviewCallback(data: string): string | null {
  if (!data.startsWith(SESSION_PREVIEW_CALLBACK_PREFIX)) return null;
  const id = data.slice(SESSION_PREVIEW_CALLBACK_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function parseSessionContinueCallback(data: string): string | null {
  if (!data.startsWith(SESSION_CONTINUE_CALLBACK_PREFIX)) return null;
  const id = data.slice(SESSION_CONTINUE_CALLBACK_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function parseBackgroundSessionCallback(data: string): BackgroundSessionCallbackPayload | null {
  if (!data.startsWith(BACKGROUND_SESSION_CALLBACK_PREFIX)) return null;
  const payload = data.slice(BACKGROUND_SESSION_CALLBACK_PREFIX.length);
  const separator = payload.indexOf(":");
  if (separator < 0) return payload.length > 0 ? { sessionId: payload, kind: null } : null;
  const marker = payload.slice(0, separator);
  const sessionId = payload.slice(separator + 1);
  const kind = BACKGROUND_SESSION_KIND_BY_CALLBACK_MARKER[marker];
  return kind && sessionId ? { sessionId, kind } : null;
}

export function buildBackgroundSessionOpenKeyboard(sessionId: string, kind: BackgroundSessionOpenKind): InlineKeyboard {
  return new InlineKeyboard().text(t("background.open_session_button"), `${BACKGROUND_SESSION_CALLBACK_PREFIX}${BACKGROUND_SESSION_KIND_CALLBACK_MARKERS[kind]}:${sessionId}`);
}

function formatSessionsSelectText(page: number): string { return page === 0 ? "🕘 Recent chats" : `🕘 Recent chats · page ${page + 1}`; }

export async function loadSessionPage(directory: string, page: number, pageSize: number): Promise<SessionPage> {
  const startIndex = page * pageSize;
  const endExclusive = startIndex + pageSize;
  const { data: sessions, error } = await opencodeClient.session.list({ directory, limit: endExclusive + SESSION_FETCH_EXTRA_COUNT, roots: true });
  if (error || !sessions) throw error || new Error("No data received from server");
  const hasNext = sessions.length > endExclusive;
  const pagedSessions = sessions.slice(startIndex, endExclusive);
  logger.debug(`[Sessions] Loaded page=${page + 1}, items=${pagedSessions.length}, hasNext=${hasNext}`);
  return { sessions: pagedSessions as SessionListItem[], hasNext, page };
}

function truncateButtonTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized.length <= SESSION_BUTTON_MAX_LENGTH ? normalized : `${normalized.slice(0, SESSION_BUTTON_MAX_LENGTH - 1).trimEnd()}…`;
}

function buildSessionsKeyboard(pageData: SessionPage): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const locale = getDateLocale();
  pageData.sessions.forEach((session) => {
    const date = new Date(session.time.created).toLocaleDateString(locale, { month: "short", day: "numeric" });
    keyboard.text(`${truncateButtonTitle(session.title)} · ${date}`, buildSessionPreviewCallback(session.id)).row();
  });
  if (pageData.page > 0) keyboard.text("← Prev", buildSessionPageCallback(pageData.page - 1));
  if (pageData.hasNext) keyboard.text("Next →", buildSessionPageCallback(pageData.page + 1));
  if (pageData.page > 0 || pageData.hasNext) keyboard.row();
  return keyboard;
}

export function buildSessionSelectionMenuView(pageData: SessionPage, _pageSize: number): { text: string; keyboard: InlineKeyboard } {
  return { text: formatSessionsSelectText(pageData.page), keyboard: buildSessionsKeyboard(pageData) };
}

export async function loadSessionPreviewItems(sessionId: string, directory: string, limit = 10): Promise<Array<{ role: "user" | "assistant"; text: string; created: number }>> {
  const { data: messages, error } = await opencodeClient.session.messages({ sessionID: sessionId, directory, limit });
  if (error || !messages) throw error || new Error("Failed to load session messages");
  return messages
    .map(({ info, parts }) => {
      const role = info.role as "user" | "assistant" | undefined;
      if ((role !== "user" && role !== "assistant") || (role === "assistant" && info.summary)) return null;
      const textParts = parts
        .filter((part) => part.type === "text" && "text" in part && typeof part.text === "string")
        .map((part) => ("text" in part ? part.text : ""));
      const text = textParts.join("").trim();
      if (!text) return null;
      return { role, text, created: info.time?.created ?? 0 };
    })
    .filter((item): item is { role: "user" | "assistant"; text: string; created: number } => Boolean(item))
    .sort((a, b) => a.created - b.created)
    .slice(-limit);
}

export function formatSessionPreview(title: string, items: Array<{ role: "user" | "assistant"; text: string }>): string {
  const lines = [`💬 ${title}`, "", "Recent messages · last 10"];
  if (items.length === 0) lines.push("No messages yet.");
  for (const item of items) {
    const label = item.role === "user" ? "You" : "Agent";
    const text = item.text.replace(/\s+/g, " ").trim();
    lines.push(`${label}: ${text.length > 280 ? `${text.slice(0, 277).trimEnd()}…` : text}`);
  }
  return lines.join("\n").slice(0, 3900);
}

export function buildSessionPreviewKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Yes, continue", buildSessionContinueCallback(sessionId))
    .text("❌ No", SESSION_NO_CALLBACK)
    .row()
    .text("← Back", SESSION_BACK_CALLBACK);
}

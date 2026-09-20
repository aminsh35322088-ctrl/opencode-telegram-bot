import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_MESSAGE_CHARS = 4096;

type Priority = "low" | "normal" | "high" | "urgent";
type NotificationStatus = "pending" | "failed";

interface StoredNotification {
  id: string;
  chatId: number;
  threadId: number;
  message: string;
  priority: Priority;
  runAt: string;
  createdAt: string;
  attempts: number;
  status: NotificationStatus;
  lastError?: string;
}

interface TelegramContextModule {
  getTelegramMessageContext(worktree: string, sessionId?: string): Promise<{ chatId: number; threadId: number } | null>;
}
interface ConfigModule {
  config: { telegram: { token: string; apiRoot: string } };
}
interface RuntimePathsModule {
  getRuntimePaths(): { appHome: string };
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let recoveryPromise: Promise<void> | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();

async function load<T>(relative: string): Promise<T> {
  return import(pathToFileURL(path.join(DIST_ROOT, relative)).href) as Promise<T>;
}

async function storePath(): Promise<string> {
  const runtime = await load<RuntimePathsModule>("runtime/paths.js");
  return path.join(runtime.getRuntimePaths().appHome, "runtime", "agent-notifications.json");
}

async function readStore(): Promise<StoredNotification[]> {
  const file = await storePath();
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is StoredNotification => {
      if (!item || typeof item !== "object") return false;
      const value = item as Partial<StoredNotification>;
      return typeof value.id === "string"
        && typeof value.chatId === "number"
        && typeof value.threadId === "number"
        && typeof value.message === "string"
        && typeof value.runAt === "string";
    }) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeStore(entries: StoredNotification[]): Promise<void> {
  const file = await storePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(entries, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

async function mutateStore<T>(mutator: (entries: StoredNotification[]) => { entries: StoredNotification[]; result: T } | Promise<{ entries: StoredNotification[]; result: T }>): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const current = await readStore();
    const next = await mutator(current);
    await writeStore(next.entries);
    return next.result;
  }, async () => {
    const current = await readStore();
    const next = await mutator(current);
    await writeStore(next.entries);
    return next.result;
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

function parseSchedule(value: string): Date {
  const normalized = value.trim();
  const relative = /^(\d+)(m|h|d)$/iu.exec(normalized);
  const date = relative
    ? new Date(Date.now() + Number(relative[1]) * (relative[2]!.toLowerCase() === "m" ? 60_000 : relative[2]!.toLowerCase() === "h" ? 3_600_000 : 86_400_000))
    : new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid schedule. Use ISO 8601 or a relative value like 30m, 2h, or 1d.");
  if (date.getTime() <= Date.now()) throw new Error("Scheduled notification must be in the future.");
  return date;
}

function formatMessage(message: string, priority: Priority, forceAlert = false): string {
  const prefix = forceAlert || priority === "urgent"
    ? priority === "urgent" ? "🚨 " : "⚠️ "
    : priority === "high" ? "⚠️ " : "";
  return `${prefix}${message}`.slice(0, MAX_MESSAGE_CHARS);
}

async function sendTelegram(entry: Pick<StoredNotification, "chatId" | "threadId" | "message" | "priority">, forceAlert = false): Promise<void> {
  const { config } = await load<ConfigModule>("config.js");
  const token = config.telegram.token;
  const apiRoot = config.telegram.apiRoot?.trim() || "https://api.telegram.org";
  const response = await fetch(`${apiRoot}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: entry.chatId,
      message_thread_id: entry.threadId || undefined,
      text: formatMessage(entry.message, entry.priority, forceAlert),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed (HTTP ${response.status}): ${body || response.statusText}`);
  }
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

function scheduleTimer(entry: StoredNotification): void {
  clearTimer(entry.id);
  if (entry.status !== "pending") return;
  const delay = Date.parse(entry.runAt) - Date.now();
  const timeout = Math.max(0, Math.min(delay, MAX_TIMER_DELAY_MS));
  const timer = setTimeout(() => {
    timers.delete(entry.id);
    if (delay > MAX_TIMER_DELAY_MS) {
      scheduleTimer(entry);
      return;
    }
    void deliverScheduled(entry.id);
  }, timeout);
  timers.set(entry.id, timer);
}

async function deliverScheduled(id: string): Promise<void> {
  const entry = (await readStore()).find((item) => item.id === id);
  if (!entry || entry.status !== "pending") return;
  try {
    await sendTelegram(entry);
    await mutateStore((entries) => ({ entries: entries.filter((item) => item.id !== id), result: undefined }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const updated = await mutateStore((entries) => {
      let nextEntry: StoredNotification | undefined;
      const next = entries.map((item) => {
        if (item.id !== id) return item;
        const attempts = (item.attempts ?? 0) + 1;
        nextEntry = attempts >= 3
          ? { ...item, attempts, status: "failed" as const, lastError: message }
          : { ...item, attempts, runAt: new Date(Date.now() + 60_000).toISOString(), lastError: message };
        return nextEntry;
      });
      return { entries: next, result: nextEntry };
    });
    if (updated?.status === "pending") scheduleTimer(updated);
  }
}

async function ensureRecovered(): Promise<void> {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    const entries = await readStore();
    for (const entry of entries) scheduleTimer(entry);
  })().catch((error) => {
    recoveryPromise = null;
    throw error;
  });
  return recoveryPromise;
}

async function currentTarget(worktree: string, sessionID: string): Promise<{ chatId: number; threadId: number }> {
  const service = await load<TelegramContextModule>("app/services/telegram-message-context-service.js");
  const context = await service.getTelegramMessageContext(worktree, sessionID);
  if (!context) throw new Error("No Telegram message context is available for the current session/worktree.");
  return { chatId: context.chatId, threadId: context.threadId };
}

export default tool({
  description: "Send or schedule bounded Telegram notifications for the current Telegram Topic. Arbitrary chat targets are rejected; schedules are persisted and recovered across tool reloads.",
  args: {
    action: tool.schema.enum(["send", "alert", "schedule", "list", "cancel"]).describe("Notification action to execute."),
    message: tool.schema.string().optional().describe("Notification text, required for send/alert/schedule."),
    target: tool.schema.string().optional().describe("Optional compatibility field; only 'current' or the current chat ID is accepted."),
    priority: tool.schema.enum(["low", "normal", "high", "urgent"]).optional().describe("Notification priority; high/urgent add an alert prefix."),
    schedule: tool.schema.string().optional().describe("For schedule: ISO 8601 or relative time such as 30m, 2h, 1d."),
    notification_id: tool.schema.string().optional().describe("Notification ID for cancel."),
  },
  async execute(args, context) {
    await ensureRecovered();
    const target = await currentTarget(context.worktree, context.sessionID);
    if (args.target?.trim() && args.target !== "current" && args.target !== String(target.chatId)) {
      throw new Error("notify can only target the current Telegram chat/topic.");
    }
    const priority = (args.priority ?? "normal") as Priority;

    if (args.action === "send" || args.action === "alert") {
      const message = args.message?.trim();
      if (!message) throw new Error(`${args.action} requires message.`);
      await sendTelegram({ ...target, message, priority }, args.action === "alert");
      return JSON.stringify({ ok: true, action: args.action, chatId: target.chatId, threadId: target.threadId }, null, 2);
    }

    if (args.action === "schedule") {
      const message = args.message?.trim();
      if (!message) throw new Error("schedule requires message.");
      if (!args.schedule?.trim()) throw new Error("schedule requires schedule.");
      const runAt = parseSchedule(args.schedule).toISOString();
      const entry: StoredNotification = {
        id: randomUUID(),
        ...target,
        message,
        priority,
        runAt,
        createdAt: new Date().toISOString(),
        attempts: 0,
        status: "pending",
      };
      await mutateStore((entries) => ({ entries: [...entries, entry], result: undefined }));
      scheduleTimer(entry);
      return JSON.stringify({ ok: true, notification: entry }, null, 2);
    }

    if (args.action === "list") {
      const entries = (await readStore()).filter((entry) => entry.chatId === target.chatId && entry.threadId === target.threadId);
      return JSON.stringify(entries, null, 2).slice(0, 30000);
    }

    const id = args.notification_id?.trim();
    if (!id) throw new Error("cancel requires notification_id.");
    const removed = await mutateStore((entries) => {
      const owned = entries.some((entry) => entry.id === id && entry.chatId === target.chatId && entry.threadId === target.threadId);
      return {
        entries: owned ? entries.filter((entry) => entry.id !== id) : entries,
        result: owned,
      };
    });
    if (removed) clearTimer(id);
    return JSON.stringify({ ok: removed, notificationId: id }, null, 2);
  },
});

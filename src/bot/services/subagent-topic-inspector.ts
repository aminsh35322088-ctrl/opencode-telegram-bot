import { InlineKeyboard, Keyboard, type Api } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";
import {
  findSubagentTopicBySession,
  findSubagentTopicsByParent,
  listSubagentTopicBindings,
  saveSubagentTopicBinding,
  updateSubagentTopicBinding,
  type SubagentTopicBinding,
} from "../../app/services/subagent-topic-store.js";
import { logger } from "../../utils/logger.js";

export const SUBAGENT_VIEW_CALLBACK_PREFIX = "subagent:view:";
export const SUBAGENT_CLOSE_BUTTON = "✖️ Close";

const SNAPSHOT_MESSAGE_LIMIT = 80;
const TELEGRAM_SAFE_TEXT_LENGTH = 3800;
const REFRESH_DEBOUNCE_MS = 500;

type EventLike = {
  type: string;
  properties: Record<string, unknown>;
};

type SessionMessageLike = {
  info?: {
    role?: string;
    agent?: string;
    time?: { created?: number };
    summary?: boolean;
  };
  parts?: Array<{
    type?: string;
    text?: string;
    tool?: string;
    state?: {
      status?: string;
      title?: string;
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
    };
  }>;
};

function normalizeTitle(title: string): string {
  const clean = title.replace(/\s+/gu, " ").trim();
  return Array.from(clean || "Sub-agent").slice(0, 128).join("");
}

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > TELEGRAM_SAFE_TEXT_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_SAFE_TEXT_LENGTH);
    if (splitAt < TELEGRAM_SAFE_TEXT_LENGTH / 2) splitAt = TELEGRAM_SAFE_TEXT_LENGTH;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length > 0 ? chunks : ["⚙️ Waiting for sub-agent activity…"];
}

function compactValue(value: unknown, max = 240): string {
  if (typeof value === "string") {
    const clean = value.replace(/\s+/gu, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  }
  if (value === undefined || value === null) return "";
  try {
    const json = JSON.stringify(value);
    return json.length > max ? `${json.slice(0, max - 1)}…` : json;
  } catch {
    return String(value);
  }
}

function renderToolPart(part: NonNullable<SessionMessageLike["parts"]>[number]): string {
  const tool = part.tool?.trim() || "tool";
  const state = part.state;
  const status = state?.status ?? "running";
  const icon =
    status === "completed" ? "✅" : status === "error" ? "❌" : status === "pending" ? "⏳" : "🛠️";
  const title = state?.title?.trim();
  const detail =
    title ||
    compactValue(
      state?.input &&
        Object.fromEntries(
          Object.entries(state.input).filter(([key]) =>
            ["path", "filePath", "command", "query", "pattern", "url", "name"].includes(key),
          ),
        ),
    );
  const error = status === "error" ? compactValue(state?.error, 420) : "";
  return [`${icon} ${tool}${detail ? ` · ${detail}` : ""}`, error].filter(Boolean).join("\n");
}

function renderSessionTranscript(messages: SessionMessageLike[]): string[] {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.info?.summary) continue;
    const role = message.info?.role;
    if (role !== "user" && role !== "assistant") continue;

    const body: string[] = [];
    let sawReasoning = false;
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.text?.trim()) {
        body.push(part.text.trim());
      } else if (part.type === "tool") {
        body.push(renderToolPart(part));
      } else if (part.type === "reasoning") {
        sawReasoning = true;
      }
    }
    if (sawReasoning && body.length === 0) body.push("🧠 Reasoning in progress");
    if (body.length === 0) continue;

    const label =
      role === "user"
        ? "📥 Delegated task"
        : `🤖 ${message.info?.agent?.trim() || "Sub-agent"}`;
    blocks.push(`${label}\n${body.join("\n\n")}`);
  }

  return splitText(blocks.join("\n\n──────────\n\n"));
}

function extractEventSessionId(event: EventLike): string | null {
  const properties = event.properties;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = properties.info;
  if (info && typeof info === "object" && typeof Reflect.get(info, "sessionID") === "string") {
    return Reflect.get(info, "sessionID") as string;
  }
  const part = properties.part;
  if (part && typeof part === "object" && typeof Reflect.get(part, "sessionID") === "string") {
    return Reflect.get(part, "sessionID") as string;
  }
  return null;
}

function closeKeyboard(): Keyboard {
  return new Keyboard().text(SUBAGENT_CLOSE_BUTTON).resized().persistent();
}

function inspectorHeader(binding: SubagentTopicBinding): string {
  return [
    "👁 <b>Sub-agent Inspector</b>",
    "",
    `🧩 ${binding.title}`,
    "🔒 Read-only · controlled by the parent chat",
    "",
    binding.paused
      ? "⏸️ Paused with the parent chat."
      : "Live activity from this child session appears below.",
  ].join("\n");
}

async function safeEditMessage(
  api: Api,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await api.editMessageText(chatId, messageId, text);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (!message.includes("message is not modified")) throw error;
  }
}

class SubagentTopicInspector {
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly openedTopicLinks = new Map<string, string>();

  buildParentKeyboard(
    subagents: Array<{ sessionId: string | null; agent: string; description: string }>,
  ): InlineKeyboard | null {
    const available = subagents.filter(
      (subagent): subagent is { sessionId: string; agent: string; description: string } =>
        Boolean(subagent.sessionId),
    );
    if (available.length === 0) return null;
    const keyboard = new InlineKeyboard();
    for (const subagent of available) {
      const label = subagent.agent?.trim() || "Sub-agent";
      const openLink = this.openedTopicLinks.get(subagent.sessionId);
      if (openLink) keyboard.url(`↗️ Open ${label}`, openLink).row();
      else keyboard.text(`👁 View ${label}`, `${SUBAGENT_VIEW_CALLBACK_PREFIX}${subagent.sessionId}`).row();
    }
    return keyboard;
  }

  parentKeyboardFingerprint(
    subagents: Array<{ sessionId: string | null }>,
  ): string {
    return subagents
      .map((subagent) => subagent.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId))
      .map((sessionId) => `${sessionId}:${this.openedTopicLinks.has(sessionId) ? "open" : "lazy"}`)
      .join("|");
  }

  buildTopicDeepLink(botId: number, threadId: number): string {
    return `tg://openmessage?user_id=${botId}&message_id=${threadId}`;
  }

  async open(
    api: Api,
    input: {
      chatId: number;
      botId: number;
      parentSessionId: string;
      sessionId: string;
      directory: string;
      title: string;
    },
  ): Promise<{ binding: SubagentTopicBinding; deepLink: string }> {
    let binding = await findSubagentTopicBySession(input.chatId, input.sessionId);
    if (binding) {
      if (binding.closed) {
        await api.raw
          .reopenForumTopic({
            chat_id: binding.chatId,
            message_thread_id: binding.threadId,
          })
          .catch((error) => {
            logger.warn(
              `[SubagentTopics] Could not reopen topic: child=${binding!.sessionId} thread=${binding!.threadId}`,
              error,
            );
          });
      }
      binding = {
        ...binding,
        parentSessionId: input.parentSessionId,
        directory: input.directory,
        title: normalizeTitle(input.title),
        closed: false,
        paused: isChatPaused(input.parentSessionId),
        updatedAt: new Date().toISOString(),
      };
    } else {
      const title = normalizeTitle(`🧩 ${input.title || "Sub-agent"}`);
      const created = await api.raw.createForumTopic({
        chat_id: input.chatId,
        name: title,
      });
      if (!created.message_thread_id) {
        throw new Error("Telegram created a sub-agent topic without a message_thread_id");
      }
      const now = new Date().toISOString();
      binding = {
        chatId: input.chatId,
        threadId: created.message_thread_id,
        parentSessionId: input.parentSessionId,
        sessionId: input.sessionId,
        directory: input.directory,
        title: normalizeTitle(input.title),
        createdAt: now,
        updatedAt: now,
        closed: false,
        paused: isChatPaused(input.parentSessionId),
        messageIds: [],
      };
      logger.info(
        `[SubagentTopics] Created read-only inspector: parent=${input.parentSessionId} child=${input.sessionId} thread=${binding.threadId}`,
      );
    }

    await saveSubagentTopicBinding(binding);

    const header = await api.sendMessage(binding.chatId, inspectorHeader(binding), {
      parse_mode: "HTML",
      message_thread_id: binding.threadId,
      reply_markup: closeKeyboard(),
      disable_notification: true,
    });
    binding = {
      ...binding,
      statusMessageId: header.message_id,
      updatedAt: new Date().toISOString(),
    };
    await saveSubagentTopicBinding(binding);
    const deepLink = this.buildTopicDeepLink(input.botId, binding.threadId);
    this.openedTopicLinks.set(binding.sessionId, deepLink);
    await this.refresh(api, binding);
    return {
      binding,
      deepLink,
    };
  }

  processEvent(event: EventLike, directory: string, api: Api | null): void {
    if (!api) return;
    const sessionId = extractEventSessionId(event);
    if (!sessionId) return;
    void findSubagentTopicBySessionForAnyChat(sessionId).then((binding) => {
      if (!binding || binding.directory !== directory || binding.closed || binding.paused) return;
      this.scheduleRefresh(api, binding);
    }).catch((error) => {
      logger.debug(`[SubagentTopics] Event lookup failed for child=${sessionId}`, error);
    });
  }

  private scheduleRefresh(api: Api, binding: SubagentTopicBinding): void {
    const key = `${binding.chatId}:${binding.sessionId}`;
    const existing = this.refreshTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.refreshTimers.delete(key);
      void this.refresh(api, binding).catch((error) => {
        logger.warn(
          `[SubagentTopics] Live refresh failed: child=${binding.sessionId} thread=${binding.threadId}`,
          error,
        );
      });
    }, REFRESH_DEBOUNCE_MS);
    timer.unref?.();
    this.refreshTimers.set(key, timer);
  }

  async refresh(api: Api, binding: SubagentTopicBinding): Promise<void> {
    const latest = await findSubagentTopicBySession(binding.chatId, binding.sessionId);
    if (!latest || latest.closed || latest.paused) return;

    const { data, error } = await opencodeClient.session.messages({
      sessionID: latest.sessionId,
      directory: latest.directory,
      limit: SNAPSHOT_MESSAGE_LIMIT,
    });
    if (error || !data) {
      logger.debug(`[SubagentTopics] Could not load child transcript: child=${latest.sessionId}`, error);
      return;
    }

    const parts = renderSessionTranscript(data as SessionMessageLike[]);
    const ids = [...latest.messageIds];
    for (let index = 0; index < parts.length; index++) {
      const text = parts[index]!;
      const existingId = ids[index];
      if (existingId) {
        await safeEditMessage(api, latest.chatId, existingId, text);
      } else {
        const sent = await api.sendMessage(latest.chatId, text, {
          message_thread_id: latest.threadId,
          disable_notification: true,
        });
        ids[index] = sent.message_id;
      }
    }

    for (let index = ids.length - 1; index >= parts.length; index--) {
      const id = ids[index];
      if (id) await api.deleteMessage(latest.chatId, id).catch(() => {});
      ids.pop();
    }

    await updateSubagentTopicBinding(latest.chatId, latest.sessionId, {
      messageIds: ids,
    });
  }

  async pauseForParent(api: Api, parentSessionId: string): Promise<void> {
    const bindings = await findSubagentTopicsByParent(parentSessionId);
    await Promise.all(
      bindings.map(async (binding) => {
        if (binding.closed) return;
        await updateSubagentTopicBinding(binding.chatId, binding.sessionId, { paused: true });
        const text = [
          "👁 <b>Sub-agent Inspector</b>",
          "",
          `🧩 ${binding.title}`,
          "🔒 Read-only · controlled by the parent chat",
          "",
          "⏸️ Paused with the parent chat.",
        ].join("\n");
        if (binding.statusMessageId) {
          await api
            .editMessageText(binding.chatId, binding.statusMessageId, text, { parse_mode: "HTML" })
            .catch(() => {});
        }
      }),
    );
  }

  async resumeForParent(api: Api, parentSessionId: string): Promise<void> {
    const bindings = await findSubagentTopicsByParent(parentSessionId);
    await Promise.all(
      bindings.map(async (binding) => {
        if (binding.closed) return;
        await updateSubagentTopicBinding(binding.chatId, binding.sessionId, { paused: false });
        if (binding.statusMessageId) {
          await api
            .editMessageText(
              binding.chatId,
              binding.statusMessageId,
              [
                "👁 <b>Sub-agent Inspector</b>",
                "",
                `🧩 ${binding.title}`,
                "🔒 Read-only · controlled by the parent chat",
                "",
                "▶️ Resumed with the parent chat.",
              ].join("\n"),
              { parse_mode: "HTML" },
            )
            .catch(() => {});
        }
        const latest = await findSubagentTopicBySession(binding.chatId, binding.sessionId);
        if (latest) await this.refresh(api, latest);
      }),
    );
  }

  async close(
    api: Api,
    binding: SubagentTopicBinding,
    reason: "user" | "parent_abort",
  ): Promise<void> {
    if (binding.closed) return;
    const text =
      reason === "parent_abort"
        ? "🛑 Parent chat aborted. This read-only inspector is now closed."
        : "✖️ Sub-agent inspector closed.";
    await api
      .sendMessage(binding.chatId, text, {
        message_thread_id: binding.threadId,
        reply_markup: { remove_keyboard: true },
        disable_notification: true,
      })
      .catch(() => {});
    await api.raw
      .closeForumTopic({
        chat_id: binding.chatId,
        message_thread_id: binding.threadId,
      })
      .catch((error) => {
        logger.warn(
          `[SubagentTopics] Failed to close inspector: child=${binding.sessionId} thread=${binding.threadId}`,
          error,
        );
      });
    await updateSubagentTopicBinding(binding.chatId, binding.sessionId, {
      closed: true,
      paused: false,
    });
    this.openedTopicLinks.delete(binding.sessionId);
  }

  async closeForParent(api: Api, parentSessionId: string): Promise<void> {
    const bindings = await findSubagentTopicsByParent(parentSessionId);
    await Promise.all(bindings.map((binding) => this.close(api, binding, "parent_abort")));
  }
}

async function findSubagentTopicBySessionForAnyChat(
  sessionId: string,
): Promise<SubagentTopicBinding | null> {
  return (
    (await listSubagentTopicBindings()).find(
      (binding) => binding.sessionId === sessionId,
    ) ?? null
  );
}

export const subagentTopicInspector = new SubagentTopicInspector();

import { createMainInlineKeyboard } from "../bot/keyboards/main-reply-keyboard.js";
import type { CloudTelegram } from "./telegram.js";
import type { LegacyMainStatus, LegacyUiAdapter } from "./legacy-ui-adapter.js";

export type LegacyButton = { text: string; callback_data?: string; url?: string };
export interface LegacyPanel {
  text: string;
  rows: LegacyButton[][];
  parseMode?: "HTML";
}

interface PanelState {
  messageId: number;
  fingerprint?: string;
  actorId?: number;
}

const escape = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function openCodeVersion(coreVersion: string): string {
  return /^v?(\d+\.\d+\.\d+)/.exec(coreVersion)?.[1] ?? coreVersion;
}

export function renderLegacyMainStatus(status: LegacyMainStatus): string {
  const model = status.model || "Not configured";
  return [
    "⚡ <b>OpenCode Telegram</b>",
    "",
    "🟢 <b>Ready</b>",
    `🤖 Bot <b>v${escape(status.botVersion)}</b>`,
    `🧠 OpenCode <b>v${escape(openCodeVersion(status.coreVersion))}</b>`,
    `🤖 ${escape(model)}`,
    `🛠️ ${escape(status.agent || "build")}`,
    "",
    "Build, debug and control OpenCode directly from Telegram.",
    "",
    "💬 Use New Chat to start a fresh coding Topic, or open an existing Topic to continue its session.",
  ].join("\n");
}

export class LegacyMainUi {
  constructor(
    private readonly adapter: LegacyUiAdapter,
    private readonly telegram: Pick<CloudTelegram, "call">,
  ) {}

  async replaceCanonicalMainPanel(chatId: number, actorId: number): Promise<void> {
    const previous = this.adapter.getUiState<PanelState>(this.mainKey(chatId));
    const panel = await this.homePanel();
    const sent = await this.telegram.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: panel.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: panel.rows },
    });
    try {
      await this.telegram.call("pinChatMessage", {
        chat_id: chatId,
        message_id: sent.message_id,
        disable_notification: true,
      });
    } catch (error) {
      await this.telegram
        .call("deleteMessage", { chat_id: chatId, message_id: sent.message_id })
        .catch(() => undefined);
      if (previous)
        await this.telegram
          .call("pinChatMessage", {
            chat_id: chatId,
            message_id: previous.messageId,
            disable_notification: true,
          })
          .catch(() => undefined);
      throw error;
    }
    const state: PanelState = {
      messageId: sent.message_id,
      fingerprint: this.fingerprint(panel),
      actorId,
    };
    this.adapter.setUiState(this.mainKey(chatId), state);
    this.adapter.setUiState(this.panelKey(chatId, undefined), state);
    if (previous && previous.messageId !== sent.message_id) {
      await this.telegram
        .call("unpinChatMessage", { chat_id: chatId, message_id: previous.messageId })
        .catch(() => undefined);
      await this.telegram
        .call("deleteMessage", { chat_id: chatId, message_id: previous.messageId })
        .catch(() => undefined);
    }
    const menu = this.adapter.getUiState<PanelState>(this.menuKey(chatId));
    if (menu && menu.messageId !== sent.message_id)
      await this.telegram
        .call("deleteMessage", { chat_id: chatId, message_id: menu.messageId })
        .catch(() => undefined);
    this.adapter.deleteUiState(this.menuKey(chatId));
  }

  async showHome(chatId: number): Promise<void> {
    await this.editCanonicalPanel(chatId, undefined, await this.homePanel());
  }

  /** Return an exact Telegram deep link to the durable pinned Main panel when the chat is a supergroup. */
  mainPanelLink(chatId: number): string | undefined {
    const state = this.adapter.getUiState<PanelState>(this.mainKey(chatId));
    if (!state?.messageId) return undefined;
    const id = String(chatId);
    if (!id.startsWith("-100") || id.length <= 4) return undefined;
    return `https://t.me/c/${id.slice(4)}/${state.messageId}`;
  }

  /** General navigation lives on a separate durable panel so the pinned Home message stays immutable. */
  async editCanonicalMenuPanel(chatId: number, panel: LegacyPanel): Promise<void> {
    const key = this.menuKey(chatId);
    const current = this.adapter.getUiState<PanelState>(key);
    const fingerprint = this.fingerprint(panel);
    if (current?.fingerprint === fingerprint) return;
    if (current) {
      try {
        await this.telegram.call("editMessageText", {
          chat_id: chatId,
          message_id: current.messageId,
          text: panel.text.slice(0, 4000),
          parse_mode: panel.parseMode ?? "HTML",
          reply_markup: { inline_keyboard: panel.rows },
        });
        this.adapter.setUiState(key, { ...current, fingerprint });
        return;
      } catch {
        // Missing/retired menu panel: create one replacement without touching the pinned Home panel.
      }
    }
    const sent = await this.telegram.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: panel.text.slice(0, 4000),
      parse_mode: panel.parseMode ?? "HTML",
      reply_markup: { inline_keyboard: panel.rows },
    });
    this.adapter.setUiState(key, { messageId: sent.message_id, fingerprint });
    if (current && current.messageId !== sent.message_id)
      await this.telegram
        .call("deleteMessage", { chat_id: chatId, message_id: current.messageId })
        .catch(() => undefined);
  }

  async editCanonicalPanel(
    chatId: number,
    threadId: number | undefined,
    panel: LegacyPanel,
  ): Promise<void> {
    const key = this.panelKey(chatId, threadId);
    const current =
      this.adapter.getUiState<PanelState>(key) ??
      (threadId === undefined
        ? this.adapter.getUiState<PanelState>(this.mainKey(chatId))
        : undefined);
    const fingerprint = this.fingerprint(panel);
    if (current?.fingerprint === fingerprint) return;
    if (current) {
      try {
        await this.telegram.call("editMessageText", {
          chat_id: chatId,
          message_id: current.messageId,
          ...(threadId ? { message_thread_id: threadId } : {}),
          text: panel.text.slice(0, 4000),
          parse_mode: panel.parseMode ?? "HTML",
          reply_markup: { inline_keyboard: panel.rows },
        });
        const next = { ...current, fingerprint };
        this.adapter.setUiState(key, next);
        if (threadId === undefined) this.adapter.setUiState(this.mainKey(chatId), next);
        return;
      } catch {
        // A missing/retired message gets a replacement. Ambiguous transport is
        // reconciled by the durable message id on the next interaction.
      }
    }
    const sent = await this.telegram.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      text: panel.text.slice(0, 4000),
      parse_mode: panel.parseMode ?? "HTML",
      reply_markup: { inline_keyboard: panel.rows },
    });
    const next: PanelState = { messageId: sent.message_id, fingerprint };
    this.adapter.setUiState(key, next);
    if (threadId === undefined) {
      await this.telegram.call("pinChatMessage", {
        chat_id: chatId,
        message_id: sent.message_id,
        disable_notification: true,
      });
      this.adapter.setUiState(this.mainKey(chatId), next);
      if (current && current.messageId !== sent.message_id) {
        await this.telegram
          .call("unpinChatMessage", { chat_id: chatId, message_id: current.messageId })
          .catch(() => undefined);
        await this.telegram
          .call("deleteMessage", { chat_id: chatId, message_id: current.messageId })
          .catch(() => undefined);
      }
    }
  }

  private async homePanel(): Promise<LegacyPanel> {
    const status = await this.adapter.getMainStatus();
    const selected = status.model;
    const split = selected.indexOf("/");
    const keyboard = createMainInlineKeyboard({
      providerID: split > 0 ? selected.slice(0, split) : "",
      modelID: split > 0 ? selected.slice(split + 1) : "",
    });
    return {
      text: renderLegacyMainStatus(status),
      rows: keyboard.inline_keyboard as LegacyButton[][],
      parseMode: "HTML",
    };
  }

  private mainKey(chatId: number): string {
    return `legacy:main:${chatId}`;
  }

  private menuKey(chatId: number): string {
    return `legacy:menu:${chatId}`;
  }

  private panelKey(chatId: number, threadId: number | undefined): string {
    return `legacy:panel:${chatId}:${threadId ?? 0}`;
  }

  private fingerprint(panel: LegacyPanel): string {
    return JSON.stringify([panel.text, panel.rows]);
  }
}

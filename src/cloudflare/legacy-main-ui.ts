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
  constructor(private readonly adapter: LegacyUiAdapter) {}

  /** Return an exact Telegram deep link to the durable pinned Main panel when the chat is a supergroup. */
  mainPanelLink(chatId: number): string | undefined {
    const state = this.adapter.getUiState<PanelState>(this.mainKey(chatId));
    if (!state?.messageId) return undefined;
    const id = String(chatId);
    if (!id.startsWith("-100") || id.length <= 4) return undefined;
    return `https://t.me/c/${id.slice(4)}/${state.messageId}`;
  }

  private mainKey(chatId: number): string {
    return `legacy:main:${chatId}`;
  }
}

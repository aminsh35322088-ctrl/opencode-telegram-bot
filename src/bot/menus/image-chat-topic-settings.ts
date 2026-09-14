import { InlineKeyboard } from "grammy";
import type { ImageChatState } from "../../app/types/image-chat.js";
import { IMAGE_HISTORY_TTL, MAX_IMAGE_HISTORY_BYTES, MAX_IMAGE_TURNS } from "../../app/stores/image-chat-store.js";

export const ICHAT_CFG_PREFIX = "ichat:cfg";
export const ICHAT_CFG_ROOT = `${ICHAT_CFG_PREFIX}`;
export const ICHAT_CFG_DELIVERY = `${ICHAT_CFG_PREFIX}:delivery`;
export const ICHAT_CFG_QUEUE = `${ICHAT_CFG_PREFIX}:queue`;
export const ICHAT_CFG_CONTEXT = `${ICHAT_CFG_PREFIX}:context`;
export const ICHAT_CFG_SILENT = `${ICHAT_CFG_PREFIX}:silent`;
export const ICHAT_CFG_FORMAT = `${ICHAT_CFG_PREFIX}:format`;
export const ICHAT_CFG_REPEAT = `${ICHAT_CFG_PREFIX}:repeat`;
export const ICHAT_CFG_HELP = `${ICHAT_CFG_PREFIX}:help`;
export const ICHAT_CFG_CLOSE = `${ICHAT_CFG_PREFIX}:close`;

export const IMAGE_CHAT_HELP_TEXT =
  "❓ <b>Image Chat help</b>\n\n" +
  "• Send text to discuss or request an image.\n" +
  "• Send a photo without a caption: it is kept as a reference only.\n" +
  "• Reply to any image to branch edits from that exact version.\n" +
  "• Albums: up to 4 reference images per request (native Gemini mode).\n" +
  "• Generated images arrive as files so later edits keep original pixels.\n" +
  "• 🖼 New design clears the conversation; ✨ Better refines the last image.";

function statusPill(enabled: boolean): string { return enabled ? "🟢 ON" : "⚪ OFF"; }

function gauge(used: number, limit: number): string {
  if (!limit) return "░░░░░░░░░░░░░░░░░░░░";
  const percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  const filled = Math.round(percent / 5);
  return `${"█".repeat(filled)}${"░".repeat(20 - filled)}  ${percent}%`;
}

function formatValue(value: string): string { return `<code>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`; }

export function buildImageChatTopicSettingsView(state: ImageChatState): { text: string; keyboard: InlineKeyboard } {
  const p = state.profile;
  const lines = [
    "🎨 <b>Topic Settings</b>",
    "",
    `🤖 <b>Chat Model</b> · ${formatValue(p.modelID)}`,
    p.mode === "gemini"
      ? `🖼 <b>Image Model</b> · native Gemini output`
      : `🖼 <b>Image Model</b> · ${formatValue(p.imageModelID ?? "?")}${p.imageEditModelID && p.imageEditModelID !== p.imageModelID ? ` / edit ${formatValue(p.imageEditModelID)}` : ""}`,
    `⚙️ <b>Mode</b> · ${p.mode === "gemini" ? "Gemini native" : "Conversation + image tool"}`,
    "",
    "💬 <b>Delivery & Output</b> · silent mode and message format",
    `📥 <b>Request Queue</b> · tap to inspect this Topic's queue`,
    `🧠 <b>Context Health</b> · ${state.turns.length}/${MAX_IMAGE_TURNS} turns retained`,
    "",
    "The model profile is pinned to this Topic. Changing defaults in Main affects new Topics only.",
  ];
  const keyboard = new InlineKeyboard()
    .text("💬 Delivery & Output", ICHAT_CFG_DELIVERY).row()
    .text("📥 Request Queue", ICHAT_CFG_QUEUE).row()
    .text("🧠 Context Health", ICHAT_CFG_CONTEXT).row()
    .text("🔁 Repeat last", ICHAT_CFG_REPEAT).text("❓ Help", ICHAT_CFG_HELP).row()
    .text("✖ Close", ICHAT_CFG_CLOSE);
  return { text: lines.join("\n"), keyboard };
}

export function buildImageChatDeliveryView(state: ImageChatState): { text: string; keyboard: InlineKeyboard } {
  const silent = state.settings?.silentDelivery === true;
  const format = state.settings?.messageFormat ?? "raw";
  return {
    text: [
      "💬 <b>Delivery & Output</b>",
      "",
      `🔕 <b>Silent delivery</b> · ${statusPill(silent)} — deliver results without notification sound.`,
      `📝 <b>Message format</b> · ${format === "markdown" ? "Markdown" : "Raw"} — render text replies with Markdown (falls back to raw on Telegram parse errors).`,
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text(`🔕 Silent delivery: ${silent ? "ON" : "OFF"}`, ICHAT_CFG_SILENT).row()
      .text(`📝 Format · ${format === "markdown" ? "Markdown" : "Raw"}`, ICHAT_CFG_FORMAT).row()
      .text("← Back", ICHAT_CFG_ROOT),
  };
}

export function buildImageChatQueueView(state: ImageChatState, queueSize: number): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      "📥 <b>Request Queue</b>",
      "",
      `Active + queued for this Topic: <b>${queueSize}</b> / 3`,
      queueSize > 0 ? "⏳ Requests run in order; each has a 180-second deadline." : "🟢 Idle. No outstanding requests.",
      "",
      "Stop cancels running and queued requests and keeps the last completed image.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("⏹ Stop all", "ichat:stop").row()
      .text("← Back", ICHAT_CFG_ROOT),
  };
}

export function buildImageChatContextView(state: ImageChatState): { text: string; keyboard: InlineKeyboard } {
  const bytes = Buffer.byteLength(JSON.stringify(state.turns));
  const idleMs = Date.now() - state.updatedAt;
  const remainingMs = Math.max(0, IMAGE_HISTORY_TTL - idleMs);
  const remainingHours = Math.floor(remainingMs / 3_600_000);
  return {
    text: [
      "🧠 <b>Context Health</b>",
      "",
      `Turns · ${state.turns.length}/${MAX_IMAGE_TURNS}`,
      gauge(state.turns.length, MAX_IMAGE_TURNS),
      `Metadata · ${Math.round(bytes / 1024)} / ${Math.round(MAX_IMAGE_HISTORY_BYTES / 1024)} KiB`,
      gauge(bytes, MAX_IMAGE_HISTORY_BYTES),
      `⏳ Context expires in ~${remainingHours}h of inactivity; the last image stays as reference.`,
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("← Back", ICHAT_CFG_ROOT),
  };
}

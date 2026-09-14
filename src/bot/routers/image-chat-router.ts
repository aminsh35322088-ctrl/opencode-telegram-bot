import { InlineKeyboard, InputFile, type Bot, type Context, type MiddlewareFn } from "grammy";
import type { Message } from "grammy/types";
import { createImageChat, getImageChat, listImageChats, removeImageChat, resetImageChat } from "../../app/stores/image-chat-store.js";
import { enqueueImageChat, isImageChatBusy, stopImageChat, stopAllImageChats, type ImageChatInput, type ImageChatIO } from "../../app/services/image-chat-service.js";
import { resolveDefaultImageChatProfile, validateImageChatProfile } from "../../app/services/image-chat-profile-service.js";
import type { ImageChatPart, ImageChatState, ImageReference } from "../../app/types/image-chat.js";
import { downloadTelegramFile } from "../../app/services/file-download-service.js";
import { validateImage } from "../../app/services/ai-http-service.js";
import { handleImageChatSetup } from "../menus/image-chat-settings.js";
import { logger } from "../../utils/logger.js";
import { clearProviderWizard } from "../commands/providers-command.js";
import { MAIN_BUTTONS } from "../keyboards/main-reply-keyboard.js";

export const NEW_IMAGE_CHAT = "🎨 New Image Chat";
const MAX_ALBUM_IMAGES = 4;
const albums = new Map<string, { timer: ReturnType<typeof setTimeout>; input: ImageChatInput; ctx: Context; overflow?: boolean }>();

function location(ctx: Context): { chatID: number; threadID: number } | undefined {
  const message = ctx.message ?? ctx.callbackQuery?.message;
  const threadID = message && "message_thread_id" in message ? message.message_thread_id : undefined;
  return ctx.chat && typeof threadID === "number" && threadID > 1 ? { chatID: ctx.chat.id, threadID } : undefined;
}
export function imageChatKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🖼 New design", "ichat:new").text("⏹ Stop", "ichat:stop").row().text("⚙️ Image settings", "ichat:settings").text("🗑 Delete", "ichat:delete");
}
export function imageReference(message: Message | undefined): ImageReference | undefined {
  if (!message) return;
  const document = message.document;
  if (document && ["image/png", "image/jpeg", "image/webp"].includes(document.mime_type ?? "")) {
    if ((document.file_size ?? 0) > 8 * 1024 * 1024) throw new Error("Images must be under 8 MB");
    return { fileID: document.file_id, mimeType: document.mime_type!, messageID: message.message_id };
  }
  const photo = message.photo?.at(-1);
  if (photo) {
    if ((photo.file_size ?? 0) > 8 * 1024 * 1024) throw new Error("Images must be under 8 MB");
    return { fileID: photo.file_id, mimeType: "image/jpeg", messageID: message.message_id };
  }
}
async function send(ctx: Context, text: string, keyboard = imageChatKeyboard()): Promise<void> {
  const loc = location(ctx);
  if (loc) await ctx.api.sendMessage(loc.chatID, text.slice(0, 4000), { message_thread_id: loc.threadID, reply_markup: keyboard });
  else await ctx.reply(text.slice(0, 4000), { reply_markup: keyboard });
}
function clearAlbums(chatID: number, threadID: number): void {
  for (const [id, album] of albums) if (album.input.chatID === chatID && album.input.threadID === threadID) { clearTimeout(album.timer); albums.delete(id); }
}
export function cleanupImageChatRouter(): void {
  for (const album of albums.values()) clearTimeout(album.timer);
  albums.clear(); stopAllImageChats();
}
export async function createNewImageChat(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const resolved = await resolveDefaultImageChatProfile();
  const profile = resolved.profile;
  await validateImageChatProfile(profile);
  if ((await listImageChats()).length >= 100) throw new Error("Delete an old Image Chat before creating another.");
  const topic = await ctx.api.createForumTopic(ctx.chat.id, "🎨 Image Chat");
  const state: ImageChatState = { kind: "image", chatID: ctx.chat.id, threadID: topic.message_thread_id, title: topic.name, profile, revision: 1, turns: [], updatedAt: Date.now(), handledMessageIDs: [] };
  try {
    await createImageChat(state);
    const selected = resolved.source === "auto" ? `\nAuto planner: ${resolved.selection}` : `\nManual planner: ${resolved.selection}`;
    await ctx.api.sendMessage(state.chatID, `🎨 Image Chat\n\nDiscuss a design, ask for an image, or send one to edit. Reply to any image to work on that version; otherwise the latest image is used.\n\nImages stay in Telegram. Use New design to start fresh.${selected}`, { message_thread_id: state.threadID, reply_markup: imageChatKeyboard() });
    await ctx.api.sendMessage(state.chatID, `🎨 Image Chat created: ${state.title}. Open its Topic to begin.`);
  } catch (error) {
    // Remove only the exact topic created by this attempt. Keep its binding if cleanup fails.
    try { await ctx.api.deleteForumTopic(state.chatID, state.threadID); await removeImageChat(state.chatID, state.threadID); } catch { logger.warn("[ImageChat] Could not clean a partially created Image Topic"); }
    throw error;
  }
}
function ioFor(ctx: Context, input: ImageChatInput): ImageChatIO {
  const sent: number[] = [];
  const rollback = async () => { for (const messageID of sent) await ctx.api.deleteMessage(input.chatID, messageID).catch(() => {}); sent.length = 0; };
  return {
    rollback,
    text: (text) => send(ctx, text),
    load: async (reference, signal) => {
      try {
        const { buffer } = await downloadTelegramFile(ctx.api, reference.fileID, { signal, maxBytes: 8 * 1024 * 1024 });
        validateImage(buffer, reference.mimeType); return { buffer, mimeType: reference.mimeType };
      } catch {
        signal.throwIfAborted();
        // Download errors may contain Telegram's token-bearing URL. Never echo them.
        throw new Error("Could not download a valid reference image. Send the image again (PNG/JPEG/WebP, up to 8 MB).");
      }
    },
    deliver: async (parts, signal) => {
      // grammY's fetch adapter uses the older abort-controller type; native signals implement its runtime contract.
      const telegramSignal = signal as unknown as Parameters<Context["api"]["sendDocument"]>[3];
      const stored: ImageChatPart[] = [];
      try {
        for (const part of parts) {
          signal.throwIfAborted();
          const value: ImageChatPart = { text: part.text, thought: part.thought, thoughtSignature: part.thoughtSignature };
          if (part.image) {
            const image = part.image; validateImage(image.buffer, image.mimeType);
            // Documents retain original pixels, avoiding cumulative compression during editing.
            const message = await ctx.api.sendDocument(input.chatID, new InputFile(image.buffer, `design.${image.mimeType.split("/")[1]}`), { message_thread_id: input.threadID, caption: "🎨 Image Chat", reply_markup: imageChatKeyboard() }, telegramSignal);
            sent.push(message.message_id); signal.throwIfAborted();
            if (!message.document) throw new Error("Telegram returned no image file ID");
            value.image = { fileID: message.document.file_id, mimeType: image.mimeType, messageID: message.message_id };
          }
          if (!part.thought && part.text?.trim()) {
            for (let at = 0; at < part.text.length; at += 3500) {
              signal.throwIfAborted();
              const message = await ctx.api.sendMessage(input.chatID, part.text.slice(at, at + 3500), { message_thread_id: input.threadID, reply_markup: imageChatKeyboard() }, telegramSignal);
              sent.push(message.message_id);
            }
          }
          stored.push(value);
        }
        signal.throwIfAborted(); return stored;
      } catch (error) {
        await rollback();
        throw error;
      }
    },
  };
}
function dispatch(ctx: Context, input: ImageChatInput): void {
  const status = ctx.api.sendMessage(input.chatID, "⏳ Image request queued. You can keep writing or tap Stop.", { message_thread_id: input.threadID, reply_markup: imageChatKeyboard() }).catch(() => undefined);
  void enqueueImageChat(input, ioFor(ctx, input)).catch(async error => {
    if (error?.name === "AbortError") return;
    logger.warn(`[ImageChat] Request failed: ${error?.name ?? "Error"}`);
    const text = error?.name === "TimeoutError" ? "The image request timed out. It was not retried; you can submit it again." : error instanceof Error ? error.message : "Image request failed";
    if (await getImageChat(input.chatID, input.threadID).catch(() => undefined)) await send(ctx, `❌ ${text}`).catch(() => {});
  }).finally(async () => {
    const message = await status;
    if (message) await ctx.api.deleteMessage(input.chatID, message.message_id).catch(() => {});
  });
}
export function createImageChatMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const loc = location(ctx), data = ctx.callbackQuery?.data, text = ctx.message?.text?.trim() ?? "";
    try {
      const state = loc ? await getImageChat(loc.chatID, loc.threadID) : undefined;
      if (!state) {
        if (!loc && data?.startsWith("icfg:")) clearProviderWizard();
        if (!loc && await handleImageChatSetup(ctx)) return;
        if (data === "main:new_image" || /^\/new_image(?:@\w+)?$/.test(text) || text === NEW_IMAGE_CHAT || text === MAIN_BUTTONS.imageAi) {
          if (data) await ctx.answerCallbackQuery().catch(() => {});
          if (!loc) clearProviderWizard();
          await createNewImageChat(ctx); return;
        }
        // Retire legacy image-mode callbacks/commands without forwarding them to OpenCode.
        if (data?.startsWith("imageai:") || data?.startsWith("ichat:") || /^\/(?:image|edit)(?:@\w+)?(?:\s|$)/.test(text) || /^\/edit(?:@\w+)?(?:\s|$)/.test(ctx.message?.caption ?? "")) {
          if (data) await ctx.answerCallbackQuery().catch(() => {});
          await ctx.reply("Use 🎨 New Image Chat to create and edit images."); return;
        }
        return next();
      }
      if (data) await ctx.answerCallbackQuery().catch(() => {});
      const isStop = data === "ichat:stop" || /^\/(stop|abort)(?:@\w+)?$/.test(text) || text === "🛑 Abort";
      if (isStop || ctx.message?.forum_topic_closed) {
        clearAlbums(state.chatID, state.threadID); await stopImageChat(state.chatID, state.threadID);
        if (isStop) await send(ctx, "⏹ Stopped. The last completed image is kept."); return;
      }
      if (data === "ichat:delete" || text === "/delete_topic" || text === "🗑️ Delete Chat") { await send(ctx, "Delete this Image Chat and its Telegram messages?", new InlineKeyboard().text("Delete permanently", "ichat:delete_confirm").text("Cancel", "ichat:settings")); return; }
      if (data === "ichat:delete_confirm") {
        clearAlbums(state.chatID, state.threadID); await stopImageChat(state.chatID, state.threadID);
        await ctx.api.deleteForumTopic(state.chatID, state.threadID); await removeImageChat(state.chatID, state.threadID); return;
      }
      if (data === "ichat:new" || /^\/new_design(?:@\w+)?$/.test(text) || data === "ichat:adopt") {
        clearAlbums(state.chatID, state.threadID); await stopImageChat(state.chatID, state.threadID);
        const resolved = data === "ichat:adopt" ? await resolveDefaultImageChatProfile() : undefined;
        if (resolved) await validateImageChatProfile(resolved.profile);
        await resetImageChat(state.chatID, state.threadID, resolved?.profile);
        await send(ctx, resolved ? `🖼 New design started with ${resolved.source === "auto" ? `Auto · ${resolved.selection}` : `Manual · ${resolved.selection}`}. Send an idea or reply to an image.` : "🖼 New design started. Send an idea or reply to an image."); return;
      }
      const oldControl = Object.values(MAIN_BUTTONS).some(value => typeof value === "string" && value === text) || ["📦 Compact: ON", "📦 Compact: OFF", "🧠 Model", "🧠 Model Center", "❌ Cancel"].includes(text);
      if (data || text === "/settings" || text === "/model" || oldControl) {
        await send(ctx, `🎨 Image Chat\nModel: ${state.profile.modelID}\n${isImageChatBusy(state.chatID, state.threadID) ? "Working / queued" : "Ready"}\n\nTo change defaults, open Settings → Default Models. Existing Image Chats keep their pinned profile until you choose New design with current default.`, new InlineKeyboard().text("New design with current default", "ichat:adopt").row().text("🖼 New design", "ichat:new").text("⏹ Stop", "ichat:stop")); return;
      }
      const message = ctx.message; if (!message || message.forum_topic_created || message.forum_topic_edited || message.forum_topic_reopened) return;
      if (text.startsWith("/") && !/^\/(?:image|edit)(?:@\w+)?(?:\s|$)/.test(text)) { await send(ctx, "This is an Image Chat. Send a design request or use its image controls."); return; }
      const image = imageReference(message);
      const reply = message.reply_to_message;
      const replyImage = reply && (reply.message_thread_id === undefined || reply.message_thread_id === state.threadID) && reply.chat.id === state.chatID ? imageReference(reply) : undefined;
      if (!text && !message.caption && !image) { await send(ctx, "Send text, a photo, or a PNG/JPEG/WebP file for this Image Chat."); return; }
      const input: ImageChatInput = { chatID: state.chatID, threadID: state.threadID, revision: state.revision, messageIDs: [message.message_id], text: (text || message.caption || "").replace(/^\/(?:image|edit)(?:@\w+)?\s*/, "").slice(0, 6000), images: image ? [image] : [], replyImage };
      if (message.media_group_id) {
        const key = `${state.chatID}:${state.threadID}:${message.media_group_id}`;
        const existing = albums.get(key);
        if (existing) {
          if (existing.input.messageIDs.includes(message.message_id)) return;
          existing.input.messageIDs.push(message.message_id);
          if (image && existing.input.images.length < MAX_ALBUM_IMAGES) existing.input.images.push(image);
          else if (image) existing.overflow = true;
          if (input.text) existing.input.text = [existing.input.text, input.text].filter(Boolean).join("\n").slice(0, 6000);
          return;
        }
        if (albums.size >= 20) { await send(ctx, "Too many pending albums. Wait a moment."); return; }
        const timer = setTimeout(() => {
          const album = albums.get(key); albums.delete(key); if (!album) return;
          if (album.overflow) void send(album.ctx, "An Image Chat accepts up to four reference images per album. Send a smaller album.").catch(() => {});
          else dispatch(album.ctx, album.input);
        }, 1200);
        timer.unref(); albums.set(key, { timer, input, ctx }); return;
      }
      dispatch(ctx, input);
    } catch (error) {
      logger.warn(`[ImageChat] Routing failed: ${error instanceof Error ? error.name : "Error"}`);
      await send(ctx, error instanceof Error ? error.message : "Image Chat is unavailable").catch(() => {});
      // Fail closed: a failed image lookup must never forward to OpenCode.
    }
  };
}
export function registerImageChatRouter(bot: Bot<Context>): void { bot.use(createImageChatMiddleware()); }

import { InlineKeyboard, InputFile, Keyboard, type Bot, type Context, type MiddlewareFn } from "grammy";
import type { Message } from "grammy/types";
import { createImageChat, getImageChat, listImageChats, removeImageChat, resetImageChat, updateImageChat } from "../../app/stores/image-chat-store.js";
import { enqueueImageChat, getImageChatQueueSize, isImageChatBusy, stopImageChat, stopAllImageChats, type ImageChatInput, type ImageChatIO } from "../../app/services/image-chat-service.js";
import { resolveDefaultImageChatProfile, validateImageChatProfile } from "../../app/services/image-chat-profile-service.js";
import type { ImageChatPart, ImageChatProfile, ImageChatState, ImageReference } from "../../app/types/image-chat.js";
import { downloadTelegramFile } from "../../app/services/file-download-service.js";
import { validateImage } from "../../app/services/ai-http-service.js";
import { handleImageChatSetup } from "../menus/image-chat-settings.js";
import { buildImageChatContextView, buildImageChatDeliveryView, buildImageChatQueueView, buildImageChatTopicSettingsView, ICHAT_CFG_CLOSE, ICHAT_CFG_CONTEXT, ICHAT_CFG_DELIVERY, ICHAT_CFG_FORMAT, ICHAT_CFG_HELP, ICHAT_CFG_PREFIX, ICHAT_CFG_QUEUE, ICHAT_CFG_REPEAT, ICHAT_CFG_ROOT, ICHAT_CFG_SILENT, IMAGE_CHAT_HELP_TEXT } from "../menus/image-chat-topic-settings.js";
import { createImageChatReplyKeyboard, IMAGE_CHAT_BUTTONS } from "../keyboards/image-chat-keyboard.js";
import { sendMessageWithMarkdownFallback } from "../messages/send-with-markdown-fallback.js";
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
function replyMarkup(profile: ImageChatProfile | undefined): InlineKeyboard | Keyboard | undefined {
  return profile ? createImageChatReplyKeyboard(profile) : undefined;
}
async function sendMenu(ctx: Context, view: { text: string; keyboard: InlineKeyboard }): Promise<void> {
  const loc = location(ctx);
  if (loc) await ctx.api.sendMessage(loc.chatID, view.text, { message_thread_id: loc.threadID, parse_mode: "HTML", reply_markup: view.keyboard });
  else await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
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
async function send(ctx: Context, text: string, options: { inline?: InlineKeyboard; profile?: ImageChatProfile } = {}): Promise<void> {
  const reply_markup = options.inline ?? replyMarkup(options.profile);
  const loc = location(ctx);
  if (loc) await ctx.api.sendMessage(loc.chatID, text.slice(0, 4000), { message_thread_id: loc.threadID, ...(reply_markup ? { reply_markup } : {}) });
  else await ctx.reply(text.slice(0, 4000), { ...(reply_markup ? { reply_markup } : {}) });
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
    await ctx.api.sendMessage(state.chatID, `🎨 Image Chat\n\nDiscuss a design, ask for an image, or send one to edit. Reply to any image to work on that version; otherwise the latest image is used.\n\nImages stay in Telegram. Use 🖼 New design to start fresh.${selected}`, { message_thread_id: state.threadID, reply_markup: createImageChatReplyKeyboard(state.profile) });
    await ctx.api.sendMessage(state.chatID, `🎨 Image Chat created: ${state.title}. Open its Topic to begin.`);
  } catch (error) {
    // Remove only the exact topic created by this attempt. Keep its binding if cleanup fails.
    try { await ctx.api.deleteForumTopic(state.chatID, state.threadID); await removeImageChat(state.chatID, state.threadID); } catch { logger.warn("[ImageChat] Could not clean a partially created Image Topic"); }
    throw error;
  }
}
function ioFor(ctx: Context, input: ImageChatInput, state: ImageChatState): ImageChatIO {
  const sent: number[] = [];
  const silent = state.settings?.silentDelivery === true;
  const markdown = state.settings?.messageFormat === "markdown";
  const rollback = async () => { for (const messageID of sent) await ctx.api.deleteMessage(input.chatID, messageID).catch(() => {}); sent.length = 0; };
  return {
    rollback,
    text: (text) => send(ctx, text, { profile: state.profile }),
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
            const message = await ctx.api.sendDocument(input.chatID, new InputFile(image.buffer, `design.${image.mimeType.split("/")[1]}`), { message_thread_id: input.threadID, caption: "🎨 Image Chat", disable_notification: silent, reply_markup: createImageChatReplyKeyboard(state.profile) }, telegramSignal);
            sent.push(message.message_id); signal.throwIfAborted();
            if (!message.document) throw new Error("Telegram returned no image file ID");
            value.image = { fileID: message.document.file_id, mimeType: image.mimeType, messageID: message.message_id };
          }
          if (!part.thought && part.text?.trim()) {
            for (let at = 0; at < part.text.length; at += 3500) {
              signal.throwIfAborted();
              const message = markdown
                ? await sendMessageWithMarkdownFallback({ api: ctx.api, chatId: input.chatID, text: part.text.slice(at, at + 3500), parseMode: "Markdown", options: { message_thread_id: input.threadID, disable_notification: silent, reply_markup: createImageChatReplyKeyboard(state.profile) } })
                : await ctx.api.sendMessage(input.chatID, part.text.slice(at, at + 3500), { message_thread_id: input.threadID, disable_notification: silent, reply_markup: createImageChatReplyKeyboard(state.profile) }, telegramSignal);
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
function dispatch(ctx: Context, input: ImageChatInput, state: ImageChatState): void {
  const status = ctx.api.sendMessage(input.chatID, "⏳ Image request queued. You can keep writing or tap ⏹ Stop.", { message_thread_id: input.threadID, reply_markup: createImageChatReplyKeyboard(state.profile) }).catch(() => undefined);
  void enqueueImageChat(input, ioFor(ctx, input, state)).catch(async error => {
    if (error?.name === "AbortError") return;
    logger.warn(`[ImageChat] Request failed: ${error?.name ?? "Error"}`);
    const text = error?.name === "TimeoutError" ? "The image request timed out. It was not retried; you can submit it again." : error instanceof Error ? error.message : "Image request failed";
    if (await getImageChat(input.chatID, input.threadID).catch(() => undefined)) await send(ctx, `❌ ${text}`).catch(() => {});
  }).finally(async () => {
    const message = await status;
    if (message) await ctx.api.deleteMessage(input.chatID, message.message_id).catch(() => {});
  });
}
async function handleImageChatConfigCallback(ctx: Context, state: ImageChatState): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const edit = async (view: { text: string; keyboard: InlineKeyboard }): Promise<void> => {
    const source = ctx.callbackQuery?.message;
    if (source && "message_id" in source && "chat" in source) {
      try { await ctx.api.editMessageText(source.chat.id, source.message_id, view.text, { parse_mode: "HTML", reply_markup: view.keyboard }); return; } catch { /* fall through */ }
    }
    await sendMenu(ctx, view);
  };
  if (data === ICHAT_CFG_ROOT) { await edit(buildImageChatTopicSettingsView(state)); return; }
  if (data === ICHAT_CFG_DELIVERY) { await edit(buildImageChatDeliveryView(state)); return; }
  if (data === ICHAT_CFG_QUEUE) { await edit(buildImageChatQueueView(state, getImageChatQueueSize(state.chatID, state.threadID))); return; }
  if (data === ICHAT_CFG_CONTEXT) { await edit(buildImageChatContextView(state)); return; }
  if (data === ICHAT_CFG_SILENT || data === ICHAT_CFG_FORMAT) {
    const settings = { ...state.settings };
    if (data === ICHAT_CFG_SILENT) settings.silentDelivery = !(state.settings?.silentDelivery === true);
    else settings.messageFormat = state.settings?.messageFormat === "markdown" ? "raw" : "markdown";
    await updateImageChat(state.chatID, state.threadID, state.revision, { settings });
    const fresh = (await getImageChat(state.chatID, state.threadID)) ?? state;
    await edit(buildImageChatDeliveryView(fresh));
    return;
  }
  if (data === ICHAT_CFG_REPEAT) {
    if (!state.lastRequest?.text) { await send(ctx, "🔁 Nothing to repeat yet. Ask for an image first.", { profile: state.profile }); return; }
    dispatch(ctx, { chatID: state.chatID, threadID: state.threadID, revision: state.revision, messageIDs: [Date.now()], text: state.lastRequest.text, images: state.lastRequest.images, ...(state.lastRequest.replyImage ? { replyImage: state.lastRequest.replyImage } : {}) }, state);
    return;
  }
  if (data === ICHAT_CFG_HELP) { await sendMenu(ctx, { text: IMAGE_CHAT_HELP_TEXT, keyboard: new InlineKeyboard().text("✖ Close", ICHAT_CFG_CLOSE) }); return; }
  if (data === ICHAT_CFG_CLOSE) {
    const source = ctx.callbackQuery?.message;
    if (source && "message_id" in source && "chat" in source) await ctx.api.deleteMessage(source.chat.id, source.message_id).catch(() => {});
    return;
  }
}

export function createImageChatMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const loc = location(ctx), data = ctx.callbackQuery?.data, text = ctx.message?.text?.trim() ?? "";
    let state: ImageChatState | undefined;
    try {
      state = loc ? await getImageChat(loc.chatID, loc.threadID) : undefined;
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
      if (data?.startsWith(ICHAT_CFG_PREFIX)) { await handleImageChatConfigCallback(ctx, state); return; }
      const isStop = data === "ichat:stop" || /^\/(stop|abort)(?:@\w+)?$/.test(text) || text === "🛑 Abort" || text === IMAGE_CHAT_BUTTONS.stop;
      if (isStop || ctx.message?.forum_topic_closed) {
        clearAlbums(state.chatID, state.threadID); await stopImageChat(state.chatID, state.threadID);
        if (isStop) await send(ctx, "⏹ Stopped. The last completed image is kept.", { profile: state.profile }); return;
      }
      if (data === "ichat:delete" || text === "/delete_topic" || text === MAIN_BUTTONS.deleteChat) { await send(ctx, "Delete this Image Chat and its Telegram messages?", { inline: new InlineKeyboard().text("Delete permanently", "ichat:delete_confirm").text("Cancel", ICHAT_CFG_ROOT) }); return; }
      if (data === "ichat:delete_confirm") {
        clearAlbums(state.chatID, state.threadID); await stopImageChat(state.chatID, state.threadID);
        // Telegram deletion is best-effort: the Image Chat state must always
        // be dropped, otherwise stale entries accumulate forever.
        try { await ctx.api.deleteForumTopic(state.chatID, state.threadID); }
        catch (error) { logger.warn(`[ImageChat] Telegram topic delete failed; removing local Image Chat state anyway: chat=${state.chatID}, thread=${state.threadID}`, error); }
        await removeImageChat(state.chatID, state.threadID); return;
      }
      if (data === "ichat:new" || /^\/new_design(?:@\w+)?$/.test(text) || data === "ichat:adopt" || text === IMAGE_CHAT_BUTTONS.newDesign) {
        clearAlbums(state.chatID, state.threadID); await stopImageChat(state.chatID, state.threadID);
        const resolved = data === "ichat:adopt" ? await resolveDefaultImageChatProfile() : undefined;
        if (resolved) await validateImageChatProfile(resolved.profile);
        await resetImageChat(state.chatID, state.threadID, resolved?.profile);
        await send(ctx, resolved ? `🖼 New design started with ${resolved.source === "auto" ? `Auto · ${resolved.selection}` : `Manual · ${resolved.selection}`}. Send an idea or reply to an image.` : "🖼 New design started. Send an idea or reply to an image.", { profile: resolved?.profile ?? state.profile }); return;
      }
      if (text === MAIN_BUTTONS.topicSettings || text.startsWith(IMAGE_CHAT_BUTTONS.modelPrefix) || data === "ichat:settings") { await sendMenu(ctx, buildImageChatTopicSettingsView(state)); return; }
      const oldControl = Object.values(MAIN_BUTTONS).some(value => typeof value === "string" && value === text) || ["📦 Compact: ON", "📦 Compact: OFF", "🧠 Model", "🧠 Model Center", "❌ Cancel"].includes(text);
      if (data || text === "/settings" || text === "/model" || oldControl) {
        await send(ctx, `🎨 Image Chat\nModel: ${state.profile.modelID}\n${isImageChatBusy(state.chatID, state.threadID) ? "Working / queued" : "Ready"}\n\nTo change defaults, open Settings → Default Models. Existing Image Chats keep their pinned profile until you choose New design with current default.`, { inline: new InlineKeyboard().text("New design with current default", "ichat:adopt").row().text("🖼 New design", "ichat:new").text("⏹ Stop", "ichat:stop") }); return;
      }
      const message = ctx.message; if (!message || message.forum_topic_created || message.forum_topic_edited || message.forum_topic_reopened) return;
      if (text.startsWith("/") && !/^\/(?:image|edit)(?:@\w+)?(?:\s|$)/.test(text)) { await send(ctx, "This is an Image Chat. Send a design request or use its image controls.", { profile: state.profile }); return; }
      const image = imageReference(message);
      const reply = message.reply_to_message;
      const replyImage = reply && (reply.message_thread_id === undefined || reply.message_thread_id === state.threadID) && reply.chat.id === state.chatID ? imageReference(reply) : undefined;
      if (!text && !message.caption && !image) { await send(ctx, "Send text, a photo, or a PNG/JPEG/WebP file for this Image Chat.", { profile: state.profile }); return; }
      if (text === IMAGE_CHAT_BUTTONS.better) {
        if (!state.currentImage) { await send(ctx, "✨ Generate or send an image first, then I can refine it.", { profile: state.profile }); return; }
        dispatch(ctx, { chatID: state.chatID, threadID: state.threadID, revision: state.revision, messageIDs: [message.message_id], text: "✨ Improve the last image: keep the subject and composition, but raise quality, detail, lighting and polish.", images: [], replyImage: state.currentImage }, state);
        return;
      }
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
          else { const albumState = await getImageChat(album.input.chatID, album.input.threadID); if (albumState) dispatch(album.ctx, album.input, albumState); }
        }, 1200);
        timer.unref(); albums.set(key, { timer, input, ctx }); return;
      }
      dispatch(ctx, input, state);
    } catch (error) {
      logger.warn(`[ImageChat] Routing failed: ${error instanceof Error ? error.name : "Error"}`);
      await send(ctx, error instanceof Error ? error.message : "Image Chat is unavailable", { profile: state?.profile }).catch(() => {});
      // Fail closed: a failed image lookup must never forward to OpenCode.
    }
  };
}
export function registerImageChatRouter(bot: Bot<Context>): void { bot.use(createImageChatMiddleware()); }

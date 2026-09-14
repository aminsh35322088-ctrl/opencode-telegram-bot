import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { createImageChatMiddleware, createNewImageChat, cleanupImageChatRouter } from "../../../src/bot/routers/image-chat-router.js";
import { createImageChat, getImageChat, listImageChats, setDefaultImageChatProfile } from "../../../src/app/stores/image-chat-store.js";
import { writeAppState } from "../../../src/app/stores/app-state-store.js";
import type { ImageChatProfile } from "../../../src/app/types/image-chat.js";

const queued = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../src/app/services/image-chat-service.js", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), enqueueImageChat: queued }));
vi.mock("../../../src/app/services/image-chat-profile-service.js", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), validateImageChatProfile: vi.fn(async () => {}) }));
const profile: ImageChatProfile = { mode: "gemini", connectionID: "gemini-image-chat", modelID: "image-model", endpoint: "https://generativelanguage.googleapis.com/v1beta" };
function ctx(text = "hello", threadID?: number, callback?: string) {
  const chat = { id: 123, type: "private" }, message = { message_id: 40, chat, text, ...(threadID ? { message_thread_id: threadID } : {}) };
  return { chat, ...(callback ? { callbackQuery: { data: callback, message } } : { message }), reply: vi.fn(async () => ({ message_id: 70 })), answerCallbackQuery: vi.fn(async () => {}), api: { sendMessage: vi.fn(async () => ({ message_id: 50 })), deleteMessage: vi.fn(async () => true), createForumTopic: vi.fn(async () => ({ message_thread_id: 20, name: "Image Chat" })), deleteForumTopic: vi.fn(async () => true) } } as unknown as Context;
}
beforeEach(async () => { cleanupImageChatRouter(); await writeAppState({ version: 2 }); queued.mockClear(); });
afterEach(async () => { cleanupImageChatRouter(); await writeAppState({ version: 2 }); });
async function seed() { await createImageChat({ kind: "image", chatID: 123, threadID: 20, title: "Image", profile, revision: 1, turns: [], handledMessageIDs: [], updatedAt: Date.now() }); }

describe("Image Chat Telegram routing", () => {
  it("creates a persisted image-only topic without an OpenCode session binding", async () => {
    await setDefaultImageChatProfile(profile); const context = ctx();
    await createNewImageChat(context);
    expect(context.api.createForumTopic).toHaveBeenCalledOnce();
    expect((await listImageChats())[0]).toMatchObject({ kind: "image", threadID: 20, profile });
    expect((await listImageChats())[0]).not.toHaveProperty("sessionId");
    expect(context.api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("Image Chat"), expect.objectContaining({ message_thread_id: 20 }));
  });
  it("routes image text before all OpenCode middleware", async () => {
    await seed(); const next = vi.fn(); await createImageChatMiddleware()(ctx("make it blue", 20), next);
    expect(queued).toHaveBeenCalledWith(expect.objectContaining({ chatID: 123, threadID: 20, text: "make it blue", revision: 1 }), expect.any(Object));
    expect(next).not.toHaveBeenCalled();
  });
  it("allows ordinary coding prompts through and does not capture their errors", async () => {
    const next = vi.fn().mockRejectedValue(new Error("coding failure"));
    await expect(createImageChatMiddleware()(ctx("fix code", 30), next)).rejects.toThrow("coding failure");
    expect(queued).not.toHaveBeenCalled();
  });
  it.each(["imageai:generate", "imageai:edit"])("redirects an old %s button without starting image mode", async callback => {
    const context = ctx("", 30, callback), next = vi.fn(); await createImageChatMiddleware()(context, next);
    expect(context.reply).toHaveBeenCalledWith(expect.stringContaining("New Image Chat"));
    expect(next).not.toHaveBeenCalled(); expect(queued).not.toHaveBeenCalled();
  });
  it("consumes coding settings callbacks inside image topics", async () => {
    await seed(); const context = ctx("", 20, "mc:select:stale"), next = vi.fn(); await createImageChatMiddleware()(context, next);
    expect(next).not.toHaveBeenCalled(); expect(queued).not.toHaveBeenCalled();
    expect(context.api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("image-model"), expect.objectContaining({ message_thread_id: 20 }));
  });
  it("fails closed when the image binding cannot be read", async () => {
    await writeAppState({ version: 2, imageChats: "broken" }); const next = vi.fn();
    await createImageChatMiddleware()(ctx("edit", 20), next); expect(next).not.toHaveBeenCalled(); expect(queued).not.toHaveBeenCalled();
  });
  it("scopes replied references to the current topic", async () => {
    await seed(); const context = ctx("use this", 20);
    Object.assign(context.message!, { reply_to_message: { message_id: 5, message_thread_id: 21, chat: { id: 123 }, document: { mime_type: "image/png", file_id: "other-topic" } } });
    await createImageChatMiddleware()(context, vi.fn());
    expect(queued.mock.calls[0]?.[0]).toMatchObject({ replyImage: undefined });
  });
  it("clears pending album input when Stop is pressed", async () => {
    await seed(); vi.useFakeTimers(); const photo = ctx("", 20);
    Object.assign(photo.message!, { media_group_id: "album", photo: [{ file_id: "photo", width: 1, height: 1 }] });
    await createImageChatMiddleware()(photo, vi.fn());
    await createImageChatMiddleware()(ctx("", 20, "ichat:stop"), vi.fn());
    await vi.advanceTimersByTimeAsync(2000); expect(queued).not.toHaveBeenCalled();
    expect((await getImageChat(123, 20))?.revision).toBe(2);
  });
});

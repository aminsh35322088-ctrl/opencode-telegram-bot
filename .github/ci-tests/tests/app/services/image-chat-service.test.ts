import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { getAppStatePath, readAppState, writeAppState } from "../../../src/app/stores/app-state-store.js";
import { createImageChat, getImageChat, listImageChats, removeImageChat, resetImageChat, setDefaultImageChatProfile, updateImageChat } from "../../../src/app/stores/image-chat-store.js";
import { enqueueImageChat, isImageChatBusy, stopAllImageChats, stopImageChat, type ImageChatIO } from "../../../src/app/services/image-chat-service.js";
import type { ImageChatProfile, ImageChatState, ImageChatResultPart } from "../../../src/app/types/image-chat.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("../../../src/app/services/image-chat-engine.js", () => ({ runImageChatEngine: run }));
const profile: ImageChatProfile = { mode: "gemini", connectionID: "gemini-image-chat", endpoint: "https://generativelanguage.googleapis.com/v1beta", modelID: "image-model" };
function state(threadID = 10, chatID = 100): ImageChatState { return { kind: "image", chatID, threadID, title: "Image", profile, revision: 1, turns: [], updatedAt: Date.now(), handledMessageIDs: [] }; }
function input(threadID = 10, messageID = 1) { return { chatID: 100, threadID, messageIDs: [messageID], text: "draw a cat", images: [], revision: 1 }; }
function io(): ImageChatIO { return { text: vi.fn().mockResolvedValue(undefined), load: vi.fn(), deliver: vi.fn().mockResolvedValue([{ image: { fileID: "telegram-file", mimeType: "image/png", messageID: 42 }, thoughtSignature: "opaque-signature" }]), rollback: vi.fn().mockResolvedValue(undefined) }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(async () => { stopAllImageChats(); await writeAppState({ version: 2 }); run.mockResolvedValue([{ text: "created" }]); });
afterEach(async () => { stopAllImageChats(); await writeAppState({ version: 2 }); });

describe("dedicated Image Chat persistence and lifecycle", () => {
  it("preserves concurrent topic changes, defaults and unrelated settings", async () => {
    await writeAppState({ version: 2, settings: { marker: true } });
    await Promise.all([createImageChat(state()), createImageChat(state(11)), createImageChat(state(10, 101))]);
    await Promise.all([updateImageChat(100, 10, 1, { title: "first" }), updateImageChat(100, 11, 1, { title: "second" }), setDefaultImageChatProfile({ ...profile, modelID: "new-default" })]);
    expect((await listImageChats()).map(s => s.title).sort()).toEqual(["Image", "first", "second"]);
    expect((await getImageChat(100, 10))?.profile.modelID).toBe("image-model");
    expect((await readAppState()).settings).toEqual({ marker: true });
  });
  it("persists only Telegram references and opaque signatures across reloads", async () => {
    await createImageChat(state()); await enqueueImageChat(input(), io());
    const file = await readFile(getAppStatePath(), "utf8");
    expect(file).toContain("telegram-file"); expect(file).toContain("opaque-signature");
    expect(file).not.toContain("base64"); expect(file).not.toContain('"type": "Buffer"');
    expect(JSON.parse(file).imageChats["100:10"].currentImage.fileID).toBe("telegram-file");
    expect((await getImageChat(100, 10))?.turns).toHaveLength(2);
  });
  it("does not repeat an update after a restart/re-delivery", async () => {
    await createImageChat(state()); const transport = io();
    await enqueueImageChat(input(), transport); await enqueueImageChat(input(), transport);
    expect(run).toHaveBeenCalledTimes(1); expect(transport.deliver).toHaveBeenCalledTimes(1);
  });
  it("cancels an uncooperative provider without publishing or reviving history", async () => {
    await createImageChat(state()); const pending = deferred<ImageChatResultPart[]>(); run.mockReturnValue(pending.promise);
    const transport = io(), task = enqueueImageChat(input(), transport).catch(e => e);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await stopImageChat(100, 10); await resetImageChat(100, 10);
    pending.resolve([{ text: "late" }]); expect((await task).name).toBe("AbortError");
    expect(transport.deliver).not.toHaveBeenCalled(); expect((await getImageChat(100, 10))?.turns).toEqual([]);
  });
  it("rolls back a result cancelled during Telegram delivery", async () => {
    await createImageChat(state()); const transport = io(), delivered = deferred<never[]>();
    vi.mocked(transport.deliver).mockReturnValue(delivered.promise);
    const task = enqueueImageChat(input(), transport).catch(e => e);
    await vi.waitFor(() => expect(transport.deliver).toHaveBeenCalledOnce());
    await stopImageChat(100, 10); delivered.resolve([]); await task;
    expect(transport.rollback).toHaveBeenCalledOnce(); expect((await getImageChat(100, 10))?.turns).toEqual([]);
  });
  it("never recreates a deleted topic from a late completion", async () => {
    await createImageChat(state()); await removeImageChat(100, 10);
    expect(await updateImageChat(100, 10, 1, { title: "resurrected" })).toBe(false);
    await enqueueImageChat(input(), io()); expect(run).not.toHaveBeenCalled();
  });
  it("invalidates collected albums when New design changes the revision", async () => {
    await createImageChat(state()); await resetImageChat(100, 10);
    await expect(enqueueImageChat(input(), io())).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
  });
  it("branches from an explicit reply instead of the last generated image", async () => {
    await createImageChat({ ...state(), turns: [{ role: "user", parts: [{ text: "old topic context" }] }], currentImage: { fileID: "last", mimeType: "image/png" } });
    await enqueueImageChat({ ...input(), replyImage: { fileID: "chosen", mimeType: "image/png" } }, io());
    expect(run.mock.calls[0]?.[2]).toEqual({ fileID: "chosen", mimeType: "image/png" });
    expect(run.mock.calls[0]?.[1]).toHaveLength(1);
  });
  it("receives a reference without starting image inference", async () => {
    await createImageChat(state()); const transport = io();
    await enqueueImageChat({ ...input(), text: "", images: [{ fileID: "ref", mimeType: "image/png" }] }, transport);
    expect(run).not.toHaveBeenCalled(); expect((await getImageChat(100, 10))?.currentImage?.fileID).toBe("ref");
  });
  it("limits active jobs globally and serializes each topic", async () => {
    await Promise.all([createImageChat(state()), createImageChat(state(11)), createImageChat(state(12))]);
    const releases: Array<() => void> = []; let active = 0, peak = 0;
    run.mockImplementation(() => new Promise(resolve => { active++; peak = Math.max(peak, active); releases.push(() => { active--; resolve([{ text: "done" }]); }); }));
    const tasks = [enqueueImageChat(input(10), io()), enqueueImageChat(input(10, 2), io()), enqueueImageChat(input(11), io()), enqueueImageChat(input(12), io())];
    await vi.waitFor(() => expect(releases).toHaveLength(2)); expect(isImageChatBusy(100, 10)).toBe(true);
    releases[0]!(); releases[1]!(); await vi.waitFor(() => expect(releases).toHaveLength(4)); releases[2]!(); releases[3]!();
    await Promise.all(tasks); expect(peak).toBe(2); expect(isImageChatBusy(100, 10)).toBe(false);
  });
  it("rejects a fourth pending request for the same topic", async () => {
    await createImageChat(state()); const pending = deferred<ImageChatResultPart[]>(); run.mockReturnValue(pending.promise);
    const tasks = [1, 2, 3].map(n => enqueueImageChat(input(10, n), io()).catch(e => e));
    await expect(enqueueImageChat(input(10, 4), io())).rejects.toThrow("queue is full");
    await stopImageChat(100, 10); pending.resolve([{ text: "late" }]); await Promise.all(tasks);
  });
  it("fails closed on corrupt or mismatched image bindings", async () => {
    await writeAppState({ version: 2, imageChats: { "100:10": { ...state(), chatID: 999 } } });
    await expect(getImageChat(100, 10)).rejects.toThrow("binding is damaged");
  });
});

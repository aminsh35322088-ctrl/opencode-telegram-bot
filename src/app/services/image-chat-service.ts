import type { ImageChatPart, ImageChatResultPart, ImageChatTurn, ImageReference } from "../types/image-chat.js";
import { getImageChat, updateImageChat, IMAGE_HISTORY_TTL, MAX_IMAGE_TURNS, MAX_IMAGE_HISTORY_BYTES } from "../stores/image-chat-store.js";
import { runImageChatEngine, type LoadImage } from "./image-chat-engine.js";

const queues = new Map<string, { tail: Promise<void>; controllers: Set<AbortController> }>();
let running = 0;
const waiters: Array<() => void> = [];
const id = (chat: number, thread: number) => `${chat}:${thread}`;
export function isImageChatBusy(chat: number, thread: number): boolean { return !!queues.get(id(chat, thread))?.controllers.size; }
export function getImageChatQueueSize(chat: number, thread: number): number { return queues.get(id(chat, thread))?.controllers.size ?? 0; }
export async function stopImageChat(chat: number, thread: number): Promise<void> {
  for (const controller of queues.get(id(chat, thread))?.controllers ?? []) controller.abort();
  const state = await getImageChat(chat, thread);
  if (state) await updateImageChat(chat, thread, state.revision, { revision: state.revision + 1 });
}
export function stopAllImageChats(): void { for (const queue of queues.values()) for (const controller of queue.controllers) controller.abort(); }

export interface ImageChatInput {
  chatID: number; threadID: number; messageIDs: number[]; text: string; images: ImageReference[]; replyImage?: ImageReference;
  revision?: number;
}
export interface ImageChatIO {
  load: LoadImage;
  text: (text: string) => Promise<void>;
  deliver: (parts: ImageChatResultPart[], signal: AbortSignal) => Promise<ImageChatPart[]>;
  rollback?: () => Promise<void>;
}

async function execute(input: ImageChatInput, io: ImageChatIO, signal: AbortSignal): Promise<void> {
  const state = await getImageChat(input.chatID, input.threadID); if (!state) return;
  if (input.revision !== undefined && input.revision !== state.revision) throw new DOMException("Cancelled", "AbortError");
  if (input.messageIDs.every((messageID) => state.handledMessageIDs.includes(messageID))) return;
  signal.throwIfAborted();
  if (!(await updateImageChat(input.chatID, input.threadID, state.revision, { handledMessageIDs: [...state.handledMessageIDs, ...input.messageIDs].slice(-100) }))) return;
  const stale = Date.now() - state.updatedAt > IMAGE_HISTORY_TTL;
  let history = stale ? [] : state.turns;
  const reference = input.replyImage ?? input.images.at(-1) ?? state.currentImage;
  // An explicit reply branches from that image. Previous native thought signatures remain intact in their own history.
  if (input.replyImage && input.replyImage.fileID !== state.currentImage?.fileID) history = [];
  if (stale && state.turns.length) await io.text("The previous design context expired. Continuing a new design from the last image.");
  if (history.length >= MAX_IMAGE_TURNS || Buffer.byteLength(JSON.stringify(history)) > MAX_IMAGE_HISTORY_BYTES) {
    await io.text("This design reached its context limit. Tap New design, then reply to the image you want to continue."); return;
  }
  const imageParts = input.images.map(image => ({ image }));
  if (input.replyImage && !input.images.some((r) => r.fileID === input.replyImage!.fileID)) imageParts.unshift({ image: input.replyImage });
  if (!history.length && !imageParts.length && reference) imageParts.push({ image: reference });
  const text = input.text.trim();
  const user: ImageChatTurn = { role: "user", parts: [...(text ? [{ text }] : []), ...imageParts] };
  if (!user.parts.length) return;
  const assertCurrent = async () => {
    signal.throwIfAborted();
    const latest = await getImageChat(input.chatID, input.threadID);
    if (!latest || latest.revision !== state.revision) throw new DOMException("Cancelled", "AbortError");
  };
  if (!text && imageParts.length) {
    await assertCurrent();
    const updated = await updateImageChat(input.chatID, input.threadID, state.revision, { currentImage: reference, turns: [...history, user, { role: "model", parts: [{ text: "Reference received. What would you like to change?" }] }], updatedAt: Date.now() }, () => signal.throwIfAborted());
    if (!updated) return;
    await assertCurrent();
    await io.text("Image received. Tell me what to change, or ask a question about it."); return;
  }
  const requestTurns = [...history, user];
  const cache = new Map<string, Awaited<ReturnType<LoadImage>>>(); let loadedBytes = 0;
  const load: LoadImage = async (ref, requestSignal) => {
    requestSignal.throwIfAborted();
    let value = cache.get(ref.fileID);
    if (!value) {
      value = await io.load(ref, requestSignal); loadedBytes += value.buffer.length;
      if (loadedBytes > 24 * 1024 * 1024) throw new Error("Image context is too large. Start a new design with fewer references.");
      cache.set(ref.fileID, value);
    }
    return value;
  };
  const parts = await runImageChatEngine(state.profile, requestTurns, reference, load, signal);
  await assertCurrent();
  const delivered = await io.deliver(parts, signal);
  try {
    await assertCurrent();
  const current = delivered.filter(p => !p.thought && p.image).at(-1)?.image ?? reference;
  const turns: ImageChatTurn[] = [...requestTurns, { role: "model", parts: delivered }];
  // Never drop signature-bearing native parts silently. Oversized responses start a fresh context with an explicit notice.
  const oversized = Buffer.byteLength(JSON.stringify(turns)) > MAX_IMAGE_HISTORY_BYTES;
  const settingsPatch = text ? { lastRequest: { text, images: input.images, ...(input.replyImage ? { replyImage: input.replyImage } : {}) } } : {};
  if (await updateImageChat(input.chatID, input.threadID, state.revision, { turns: oversized ? [] : turns, currentImage: current, updatedAt: Date.now(), ...settingsPatch }, () => signal.throwIfAborted())) {
    if (oversized) await io.text("The result is saved. Its context was too large to retain; the next message starts from the latest image.");
  } else throw new DOMException("Cancelled", "AbortError");
  } catch (error) { await io.rollback?.().catch(() => {}); throw error; }
}

/** Up to three requests per topic, two active globally, at most twenty outstanding. */
export function enqueueImageChat(input: ImageChatInput, io: ImageChatIO): Promise<void> {
  const key = id(input.chatID, input.threadID);
  const queue = queues.get(key) ?? { tail: Promise.resolve(), controllers: new Set<AbortController>() };
  if (queue.controllers.size >= 3 || [...queues.values()].reduce((sum, q) => sum + q.controllers.size, 0) >= 20) return Promise.reject(new Error("Image queue is full. Wait for a result or tap Stop."));
  const controller = new AbortController(); queue.controllers.add(controller); queues.set(key, queue);
  const task = queue.tail.catch(() => {}).then(async () => {
    controller.signal.throwIfAborted();
    if (running >= 2) await new Promise<void>(resolve => waiters.push(resolve));
    else running++;
    try {
      controller.signal.throwIfAborted();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
      try { await execute(input, io, signal); }
      catch (error) { signal.throwIfAborted(); throw error; }
    } finally {
      // Hand the occupied slot directly to a waiter; a new request cannot steal it.
      const next = waiters.shift(); if (next) next(); else running--;
    }
  }).finally(() => { queue.controllers.delete(controller); if (!queue.controllers.size) queues.delete(key); });
  queue.tail = task; return task;
}

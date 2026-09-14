import { readAppState, updateAppState, type AppState } from "./app-state-store.js";
import type { ImageChatProfile, ImageChatState } from "../types/image-chat.js";

const MAX_TOPICS = 100;
export const IMAGE_HISTORY_TTL = 24 * 60 * 60 * 1000;
export const MAX_IMAGE_TURNS = 12;
export const MAX_IMAGE_HISTORY_BYTES = 128 * 1024;
const key = (chatID: number, threadID: number) => `${chatID}:${threadID}`;
function topics(state: AppState): Record<string, ImageChatState> {
  const value = state.imageChats;
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Image Chat state is damaged. Restore app-state backup.");
  return value as Record<string, ImageChatState>;
}
export function validImageChatProfile(value: unknown): value is ImageChatProfile {
  if (!value || typeof value !== "object") return false;
  const p = value as ImageChatProfile;
  return (p.mode === "gemini" || p.mode === "tools") && typeof p.connectionID === "string" && !!p.connectionID && typeof p.modelID === "string" && !!p.modelID && typeof p.endpoint === "string" && (p.mode !== "tools" || typeof p.imageProviderID === "string");
}
function validate(state: ImageChatState): ImageChatState {
  if (state.kind !== "image" || !validImageChatProfile(state.profile) || !Array.isArray(state.turns) || !Array.isArray(state.handledMessageIDs) || !Number.isInteger(state.revision)) throw new Error("Image Chat state is damaged. Restore app-state backup.");
  return state;
}
export async function getImageChat(chatID: number, threadID: number): Promise<ImageChatState | undefined> {
  const all = topics(await readAppState()), id = key(chatID, threadID);
  if (!Object.hasOwn(all, id)) return undefined;
  const value = validate(all[id]!);
  if (value.chatID !== chatID || value.threadID !== threadID) throw new Error("Image Chat binding is damaged");
  return value;
}
export async function listImageChats(): Promise<ImageChatState[]> {
  return Object.values(topics(await readAppState())).map(validate);
}
export async function createImageChat(state: ImageChatState): Promise<void> {
  await updateAppState((app) => {
    const all = topics(app);
    if (Object.keys(all).length >= MAX_TOPICS) throw new Error("Image Chat limit reached. Delete an old Image Chat first.");
    if (all[key(state.chatID, state.threadID)]) throw new Error("Image Chat already exists");
    return { imageChats: { ...all, [key(state.chatID, state.threadID)]: validate(state) } };
  });
}
/** Compare-and-swap prevents a cancelled/deleted/reconfigured topic from being resurrected. */
export async function updateImageChat(chatID: number, threadID: number, revision: number, patch: Partial<ImageChatState>, beforeWrite: () => void = () => {}): Promise<boolean> {
  let updated = false;
  await updateAppState((app) => {
    const all = topics(app), id = key(chatID, threadID), old = all[id];
    if (!old || old.revision !== revision) return {};
    beforeWrite();
    updated = true;
    return { imageChats: { ...all, [id]: { ...old, ...patch, kind: "image", chatID, threadID } } };
  });
  return updated;
}
export async function resetImageChat(chatID: number, threadID: number, profile?: ImageChatProfile): Promise<void> {
  await updateAppState((app) => {
    const all = topics(app), id = key(chatID, threadID), old = all[id];
    if (!old) return {};
    const next = { ...old, revision: old.revision + 1, turns: [], updatedAt: Date.now(), ...(profile ? { profile } : {}) };
    delete next.currentImage;
    return { imageChats: { ...all, [id]: next } };
  });
}
export async function removeImageChat(chatID: number, threadID: number): Promise<void> {
  await updateAppState((app) => {
    const all = { ...topics(app) }; delete all[key(chatID, threadID)];
    return { imageChats: all };
  });
}
export async function getDefaultImageChatProfile(): Promise<ImageChatProfile | undefined> {
  const value = (await readAppState()).imageChatDefault;
  return validImageChatProfile(value) ? value : undefined;
}
export async function setDefaultImageChatProfile(profile: ImageChatProfile): Promise<void> {
  if (!validImageChatProfile(profile)) throw new Error("Invalid Image Chat profile");
  await updateAppState({ imageChatDefault: profile });
}

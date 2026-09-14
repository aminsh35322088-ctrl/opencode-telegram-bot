import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { getDefaultImageChatProfile, listImageChats } from "../stores/image-chat-store.js";
import type { ImageChatProfile } from "../types/image-chat.js";
import { getCustomProviderConfig } from "./custom-provider-service.js";
import { getActiveImageAiProviders } from "./image-ai-provider-service.js";
import { asRecord, readBoundedJson } from "./ai-http-service.js";
import { isChatModelMetadata } from "./model-eligibility-service.js";

export const GEMINI_IMAGE_CONNECTION = "gemini-image-chat";
export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
export async function hasGeminiImageConnection(): Promise<boolean> { return Boolean(asRecord((await readAppState()).imageChatGemini).apiKey); }
export async function removeGeminiImageConnection(): Promise<void> { await updateAppState({ imageChatGemini: undefined }); }

export async function configureGeminiImageConnection(key: string, modelID: string, beforeSave: () => void = () => {}): Promise<ImageChatProfile> {
  if (!key.trim() || !/^[a-zA-Z0-9._-]{1,100}$/.test(modelID)) throw new Error("Enter a valid Gemini key and model ID");
  const response = await fetch(`${GEMINI_ENDPOINT}/models/${encodeURIComponent(modelID)}`, { headers: { "x-goog-api-key": key.trim() }, signal: AbortSignal.timeout(15_000), redirect: "error" });
  const model = asRecord(await readBoundedJson(response, 256 * 1024));
  if (!Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes("generateContent")) throw new Error("This model does not expose generateContent");
  beforeSave();
  await updateAppState(() => { beforeSave(); return { imageChatGemini: { apiKey: key.trim() } }; });
  return { mode: "gemini", connectionID: GEMINI_IMAGE_CONNECTION, modelID, endpoint: GEMINI_ENDPOINT };
}

export async function resolveImageChatConnection(profile: ImageChatProfile): Promise<{ apiKey: string; endpoint: string }> {
  if (profile.mode === "gemini") {
    if (profile.connectionID !== GEMINI_IMAGE_CONNECTION || profile.endpoint !== GEMINI_ENDPOINT) throw new Error("Image Chat connection changed. Reconfigure this Topic.");
    const apiKey = asRecord((await readAppState()).imageChatGemini).apiKey;
    if (typeof apiKey !== "string" || !apiKey) throw new Error("Gemini image connection is missing. Open AI Providers → Image.");
    return { apiKey, endpoint: GEMINI_ENDPOINT };
  }
  const config = await getCustomProviderConfig(profile.connectionID);
  const model = config?.models.find((m) => m.id === profile.modelID);
  if (!config || config.capability !== "coding" || config.apiUrl !== profile.endpoint || !model || !isChatModelMetadata(model)) throw new Error("The conversation connection/model changed or was removed. Reconfigure this Image Chat.");
  if (!model.modalities?.input?.includes("image") && model.attachment !== true) throw new Error("The conversation model needs confirmed image input support. Choose a vision model.");
  return { apiKey: config.apiKey, endpoint: config.apiUrl };
}

export async function buildToolImageChatProfile(connectionID: string, modelID: string, imageProviderID: string): Promise<ImageChatProfile> {
  const config = await getCustomProviderConfig(connectionID);
  const image = (await getActiveImageAiProviders()).find((p) => p.id === imageProviderID);
  if (!config || !image || !image.capabilities.includes("generate") || !image.capabilities.includes("edit")) throw new Error("Choose a configured image connection with both generation and editing support");
  const profile: ImageChatProfile = { mode: "tools", connectionID, modelID, endpoint: config.apiUrl, imageProviderID, imageEndpoint: image.baseURL, imageModelID: image.model, imageEditModelID: image.editModel ?? image.model };
  await resolveImageChatConnection(profile);
  return profile;
}
export async function validateImageChatProfile(profile: ImageChatProfile): Promise<void> {
  await resolveImageChatConnection(profile);
  if (profile.mode === "tools") {
    const image = (await getActiveImageAiProviders()).find((p) => p.id === profile.imageProviderID);
    if (!image || image.baseURL !== profile.imageEndpoint || image.model !== profile.imageModelID || (image.editModel ?? image.model) !== profile.imageEditModelID) throw new Error("Image generator settings changed. Start a new design with the updated settings.");
  }
}
export async function imageConnectionUsage(connectionID: string): Promise<number> {
  const uses = (p: ImageChatProfile) => p.connectionID === connectionID || p.imageProviderID === connectionID;
  const profile = await getDefaultImageChatProfile();
  return (await listImageChats()).filter((chat) => uses(chat.profile)).length + (profile && uses(profile) ? 1 : 0);
}

import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { getDefaultImageChatProfile, getImageChatDefaultMode, listImageChats } from "../stores/image-chat-store.js";
import type { ImageChatProfile } from "../types/image-chat.js";
import { getCustomProviderConfig, listCustomProviders, type CustomProvider, type CustomProviderModel } from "./custom-provider-service.js";
import { getActiveImageAiProviders } from "./image-ai-provider-service.js";
import { asRecord, readBoundedJson } from "./ai-http-service.js";
import { isChatModelMetadata } from "./model-eligibility-service.js";
import { OPENROUTER_PROVIDER_ID } from "./openrouter-provider-service.js";

export const GEMINI_IMAGE_CONNECTION = "gemini-image-chat";
export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

const AUTO_CHAT_FAMILY_PRIORITY: ReadonlyArray<{ label: string; patterns: RegExp[] }> = [
  { label: "OpenAI / GPT", patterns: [/\bopenai\b/i, /(^|[/._-])gpt[-_/0-9]/i] },
  { label: "Google / Gemini", patterns: [/\bgemini\b/i, /(^|\/)google\//i] },
  { label: "DeepSeek", patterns: [/deepseek/i] },
  { label: "Qwen", patterns: [/qwen/i] },
  { label: "GLM", patterns: [/(^|[/._-])glm[-_/0-9]/i, /zhipu/i] },
  { label: "Mistral", patterns: [/mistral/i] },
  { label: "Llama", patterns: [/llama/i] },
];

function supportsImageInput(model: CustomProviderModel): boolean {
  return isChatModelMetadata(model) && (model.modalities?.input?.includes("image") === true || model.attachment === true);
}

/**
 * We only classify OpenRouter's explicit zero-cost variants as automatically free.
 * A custom provider may be free to the owner, but its /models response does not
 * standardize price metadata, so Auto must not silently risk a paid request.
 */
function isKnownFreeModel(provider: CustomProvider, model: CustomProviderModel): boolean {
  if (provider.id !== OPENROUTER_PROVIDER_ID) return false;
  const id = model.id.toLowerCase();
  return id === "openrouter/free" || /:free(?:$|:)/.test(id);
}

function familyRank(provider: CustomProvider, model: CustomProviderModel): number {
  const haystack = `${provider.id} ${provider.name} ${model.id} ${model.name}`;
  const rank = AUTO_CHAT_FAMILY_PRIORITY.findIndex((family) => family.patterns.some((pattern) => pattern.test(haystack)));
  if (rank >= 0) return rank;
  // OpenRouter's free router is capability-aware and is the final preferred fallback.
  if (model.id.toLowerCase() === "openrouter/free") return AUTO_CHAT_FAMILY_PRIORITY.length;
  return AUTO_CHAT_FAMILY_PRIORITY.length + 1;
}

export function rankAutoImageChatModels(providers: CustomProvider[]): Array<{ providerID: string; modelID: string; family: string }> {
  return providers
    .filter((provider) => provider.capability === "coding")
    .flatMap((provider) => provider.models
      .filter((model) => isKnownFreeModel(provider, model) && supportsImageInput(model))
      .map((model) => ({ provider, model, rank: familyRank(provider, model) })))
    .sort((a, b) => a.rank - b.rank || a.model.id.localeCompare(b.model.id))
    .map(({ provider, model, rank }) => ({
      providerID: provider.id,
      modelID: model.id,
      family: AUTO_CHAT_FAMILY_PRIORITY[rank]?.label ?? (model.id.toLowerCase() === "openrouter/free" ? "OpenRouter Free Router" : "Other free model"),
    }));
}

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

export async function buildAutoImageChatProfile(): Promise<{ profile: ImageChatProfile; selection: string }> {
  const [providers, imageProviders, manual] = await Promise.all([
    listCustomProviders(),
    getActiveImageAiProviders(),
    getDefaultImageChatProfile(),
  ]);
  const imageCandidates = imageProviders.filter((provider) => provider.capabilities.includes("generate") && provider.capabilities.includes("edit"));
  const preferredImage = manual?.mode === "tools"
    ? imageCandidates.find((provider) => provider.id === manual.imageProviderID) ?? imageCandidates[0]
    : imageCandidates[0];
  if (!preferredImage) throw new Error("Auto Image Chat needs an image generator/editor. Configure one under AI Providers first.");

  const candidates = rankAutoImageChatModels(providers);
  const selected = candidates[0];
  if (!selected) {
    throw new Error("Auto Image Chat found no confirmed free vision chat model. Connect OpenRouter and keep a :free vision model (or openrouter/free), or switch Default Models → Image Chat to Manual.");
  }
  const profile = await buildToolImageChatProfile(selected.providerID, selected.modelID, preferredImage.id);
  return { profile, selection: `${selected.family} · ${selected.modelID}` };
}

export async function resolveDefaultImageChatProfile(): Promise<{ profile: ImageChatProfile; source: "auto" | "manual"; selection: string }> {
  const mode = await getImageChatDefaultMode();
  if (mode === "auto") {
    const auto = await buildAutoImageChatProfile();
    return { ...auto, source: "auto" };
  }
  const profile = await getDefaultImageChatProfile();
  if (!profile) throw new Error("Manual Image Chat defaults are not configured. Open Settings → Default Models → Image Chat.");
  await validateImageChatProfile(profile);
  return { profile, source: "manual", selection: profile.modelID };
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

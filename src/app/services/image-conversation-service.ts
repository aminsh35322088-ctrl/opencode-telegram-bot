import { getCustomProviderConfig } from "./custom-provider-service.js";
import { editImageWithFallback, generateImageWithFallback } from "./image-ai-provider-service.js";
import {
  getImageConversationState,
  setImageConversationState,
  deleteImageConversationState,
  loadImageConversationStore,
  type SerializedImageConversationState,
} from "../stores/image-conversation-store.js";
import { logger } from "../../utils/logger.js";

export type ImageConversationOperation = "generate" | "edit" | "chat";

export interface ImageConversationResult {
  reply: string;
  operation: ImageConversationOperation;
  image?: { buffer: Buffer; mimeType: string };
}

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

interface ImageConversationState {
  turns: ConversationTurn[];
  currentImage?: { buffer: Buffer; mimeType: string };
  expiresAt: number;
}

const PREFERRED_GEMINI_MODEL = "gemini-3.1-flash-lite";
const CONVERSATION_TTL_MS = 45 * 60 * 1000;
const MAX_TURNS = 12;

let storeLoaded = false;

async function ensureStoreLoaded(): Promise<void> {
  if (!storeLoaded) {
    await loadImageConversationStore();
    storeLoaded = true;
  }
}

function deserializeState(serialized: SerializedImageConversationState): ImageConversationState {
  const currentImage = serialized.currentImageBase64
    ? {
        buffer: Buffer.from(serialized.currentImageBase64, "base64"),
        mimeType: serialized.currentImageMimeType ?? "image/png",
      }
    : undefined;

  return {
    turns: serialized.turns,
    currentImage,
    expiresAt: serialized.expiresAt,
  };
}

function serializeState(state: ImageConversationState): SerializedImageConversationState {
  return {
    turns: state.turns,
    currentImageBase64: state.currentImage?.buffer.toString("base64"),
    currentImageMimeType: state.currentImage?.mimeType,
    expiresAt: state.expiresAt,
    updatedAt: Date.now(),
  };
}

const SYSTEM_PROMPT = `You are the conversational brain of a Telegram Image AI mode.\nYour job is to have a natural, friendly conversation in the user's language and decide whether the user wants an image operation.\nReturn ONLY valid JSON with this exact shape: {"reply": string, "operation": "generate"|"edit"|"chat", "instruction": string}.\nRules:\n- "reply" is a concise natural response to the user.\n- "instruction" is the complete image instruction for the image generator/editor; write it in clear English when useful, preserving important user details.\n- Use "edit" when a current image exists and the user asks to modify, refine, transform, remove, add, recolor, relight, or otherwise change it.\n- Use "generate" when the user asks for a new image or a new scene and there is no current image, or when they explicitly ask for a fresh generation.\n- Use "chat" for questions, greetings, clarifications, or requests that do not require an image.\n- Do not claim an image was changed/generated unless the operation says so.\n- Use the conversation context and the current image to resolve references such as "that one", "the tower on the right", or "make it darker".`;

function pruneTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.length > MAX_TURNS ? turns.slice(-MAX_TURNS) : turns;
}

function getStateSync(chatId: number): ImageConversationState | undefined {
  const serialized = getImageConversationState(chatId);
  if (!serialized) return undefined;
  return deserializeState(serialized);
}

async function getState(chatId: number): Promise<ImageConversationState | undefined> {
  await ensureStoreLoaded();
  return getStateSync(chatId);
}

async function upsertState(chatId: number): Promise<ImageConversationState> {
  await ensureStoreLoaded();
  const existing = getStateSync(chatId);
  if (existing) {
    existing.expiresAt = Date.now() + CONVERSATION_TTL_MS;
    return existing;
  }
  const state: ImageConversationState = { turns: [], expiresAt: Date.now() + CONVERSATION_TTL_MS };
  setImageConversationState(chatId, serializeState(state));
  return state;
}

async function saveState(chatId: number, state: ImageConversationState): Promise<void> {
  setImageConversationState(chatId, serializeState(state));
}

function extractText(payload: unknown): string {
  const choices = payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).choices)
    ? (payload as { choices: unknown[] }).choices
    : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

function parseDecision(raw: string): { reply: string; operation: ImageConversationOperation; instruction: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : "باشه.";
  const operation = parsed.operation === "generate" || parsed.operation === "edit" || parsed.operation === "chat" ? parsed.operation : "chat";
  const instruction = typeof parsed.instruction === "string" ? parsed.instruction.trim() : "";
  return { reply, operation, instruction };
}

function buildUserContent(text: string, image?: { buffer: Buffer; mimeType: string }): unknown {
  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  if (image) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}` },
    });
  }
  return content;
}

function selectGeminiModel(models: { id: string }[]): string {
  const preferred = models.find((model) => model.id === PREFERRED_GEMINI_MODEL);
  return preferred?.id ?? models[0]?.id ?? PREFERRED_GEMINI_MODEL;
}

async function askGemini(state: ImageConversationState, text: string): Promise<{ reply: string; operation: ImageConversationOperation; instruction: string }> {
  const provider = await getCustomProviderConfig("gemini");
  if (!provider) throw new Error("Gemini is not configured. Configure Gemini from /providers first.");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...state.turns,
    { role: "user", content: buildUserContent(text, state.currentImage) },
  ];

  const response = await fetch(`${provider.apiUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: selectGeminiModel(provider.models),
      messages,
      temperature: 0.4,
      max_tokens: 700,
      stream: false,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const raw = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`Gemini conversation failed (HTTP ${response.status}): ${raw.slice(0, 300)}`);
  const content = extractText(raw ? JSON.parse(raw) : null);
  if (!content) throw new Error("Gemini returned an empty conversation response.");
  try {
    return parseDecision(content);
  } catch {
    logger.warn("[ImageConversation] Gemini returned non-JSON; falling back to a conversational response");
    return { reply: content.slice(0, 1000), operation: state.currentImage ? "edit" : "generate", instruction: text };
  }
}

export async function isImageConversationActive(chatId: number): Promise<boolean> {
  const state = await getState(chatId);
  return Boolean(state);
}

export async function activateImageConversation(chatId: number): Promise<void> {
  await ensureStoreLoaded();
  const state: ImageConversationState = { turns: [], expiresAt: Date.now() + CONVERSATION_TTL_MS };
  setImageConversationState(chatId, serializeState(state));
  logger.info(`[ImageConversation] activated chatId=${chatId}`);
}

export async function clearImageConversation(chatId: number): Promise<void> {
  await ensureStoreLoaded();
  deleteImageConversationState(chatId);
  logger.info(`[ImageConversation] cleared chatId=${chatId}`);
}

export async function setCurrentImage(chatId: number, image: { buffer: Buffer; mimeType: string }): Promise<void> {
  const state = await upsertState(chatId);
  state.currentImage = image;
  await saveState(chatId, state);
}

export async function handleImageConversationText(chatId: number, text: string): Promise<ImageConversationResult> {
  const state = await upsertState(chatId);
  const decision = await askGemini(state, text);

  state.turns = pruneTurns([
    ...state.turns,
    { role: "user", content: text },
    { role: "assistant", content: decision.reply },
  ]);

  if (decision.operation === "chat" || !decision.instruction) {
    await saveState(chatId, state);
    return { reply: decision.reply, operation: "chat" };
  }

  if (decision.operation === "edit" && !state.currentImage) {
    const reply = "برای ویرایش، اول یک تصویر بفرست تا روی همان تصویر ادامه بدیم.";
    state.turns = pruneTurns([...state.turns, { role: "assistant", content: reply }]);
    await saveState(chatId, state);
    return { reply, operation: "chat" };
  }

  const result = decision.operation === "edit" && state.currentImage
    ? await editImageWithFallback(state.currentImage.buffer, state.currentImage.mimeType, decision.instruction)
    : await generateImageWithFallback(decision.instruction);

  state.currentImage = result;
  state.expiresAt = Date.now() + CONVERSATION_TTL_MS;
  await saveState(chatId, state);
  return { reply: decision.reply, operation: decision.operation, image: result };
}

export async function handleImageConversationImage(chatId: number, image: { buffer: Buffer; mimeType: string }, instruction = "Create a natural continuation of this image and preserve the important details."): Promise<ImageConversationResult> {
  const state = await upsertState(chatId);
  state.currentImage = image;
  const result = await editImageWithFallback(image.buffer, image.mimeType, instruction);
  state.currentImage = result;
  state.expiresAt = Date.now() + CONVERSATION_TTL_MS;
  const reply = "عکس رو گرفتم. از همین تصویر ادامه می‌دیم؛ بگو چه تغییری می‌خوای.";
  state.turns = pruneTurns([...state.turns, { role: "assistant", content: reply }]);
  await saveState(chatId, state);
  return { reply, operation: "edit", image: result };
}

export async function getConversationHistory(chatId: number): Promise<ConversationTurn[]> {
  const state = await getState(chatId);
  return state?.turns ?? [];
}

export async function __resetImageConversationStateForTests(): Promise<void> {
  const { __resetImageConversationStoreForTests } = await import("../stores/image-conversation-store.js");
  __resetImageConversationStoreForTests();
  storeLoaded = false;
}

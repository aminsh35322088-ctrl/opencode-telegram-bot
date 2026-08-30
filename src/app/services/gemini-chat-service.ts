import { saveCustomProvider } from "./custom-provider-service.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_CHAT_MODEL = "gemini-3.1-flash-lite";

export async function verifyAndSaveGeminiChatProvider(apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("Gemini API key is empty.");

  const response = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GEMINI_CHAT_MODEL,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 4,
      stream: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const raw = await response.text().catch(() => "");
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }

  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "error" in payload
      ? JSON.stringify((payload as Record<string, unknown>).error)
      : raw.slice(0, 300);
    throw new Error(`Gemini API verification failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }

  const choices = payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).choices)
    ? (payload as { choices: unknown[] }).choices
    : [];
  if (!choices.length) throw new Error("Gemini API responded successfully but returned no chat completion.");

  await saveCustomProvider({
    id: "gemini",
    name: "Gemini",
    baseURL: GEMINI_BASE_URL,
    apiKey: key,
    models: [{ id: GEMINI_CHAT_MODEL, name: "Gemini 3.1 Flash-Lite" }],
  });
}

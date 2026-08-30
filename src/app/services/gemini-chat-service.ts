import { saveCustomProvider, syncOpenCodeCustomConfig } from "./custom-provider-service.js";
import { config } from "../../config.js";
import { findServerPid, killServerProcess, resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";
import { reconcileStoredModelSelection } from "./model-selection-service.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_CHAT_MODEL = "gemini-3.1-flash-lite";

function errorDetail(payload: unknown, raw: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as Record<string, unknown>).error;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return raw.slice(0, 300);
}

async function restartOpenCodeAfterGeminiChange(): Promise<void> {
  const configPath = await syncOpenCodeCustomConfig();
  process.env.OPENCODE_CONFIG = configPath;
  const target = resolveLocalOpencodeTarget(config.opencode.apiUrl);
  if (!target) return;
  const pid = await findServerPid(target.port);
  if (pid) await killServerProcess(pid);
  await new Promise((resolve) => setTimeout(resolve, 500));
  startLocalOpencodeServer(target).unref();
  await reconcileStoredModelSelection({ forceCatalogRefresh: true }).catch(() => {});
}

export async function verifyAndSaveGeminiChatProvider(apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("Gemini API key is empty.");

  const response = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = raw; }

  if (!response.ok) {
    throw new Error(`Gemini API verification failed (HTTP ${response.status})${errorDetail(payload, raw) ? `: ${errorDetail(payload, raw)}` : ""}`);
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
  await restartOpenCodeAfterGeminiChange();
}

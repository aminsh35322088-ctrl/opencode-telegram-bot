import { config } from "../../config.js";
import { getGroqSttConfig } from "./custom-provider-service.js";
import { logger } from "../../utils/logger.js";

const STT_REQUEST_TIMEOUT_MS = 60_000;
export interface SttResult { text: string; }
const AUDIO_FORMAT_BY_EXTENSION: Record<string, string> = { oga: "ogg", ogg: "ogg", mp3: "mp3", wav: "wav", m4a: "m4a", flac: "flac", aac: "aac", webm: "webm" };
const GROQ_PERSIAN_LANGUAGE = "fa";
const GROQ_PERSIAN_PROMPT =
  "این گفتار فارسی محاوره‌ای است. متن را دقیق و طبیعی به فارسی پیاده‌سازی کن. کلمات انگلیسی و اصطلاحات فنی را ترجمه نکن و املای آن‌ها را حفظ کن. نام فایل‌ها، فریم‌ورک‌ها، زبان‌های برنامه‌نویسی، سرویس‌ها و نام‌های خاص را دست‌کاری نکن. اصطلاحات رایج: HTML, CSS, JavaScript, TypeScript, React, Next.js, OpenCode, GitHub, Railway, API, frontend, backend, website, portfolio, About, Services, Products, Resume, Get in touch."

/** STT can be configured by env for backwards compatibility or via Custom Providers > Groq Voice STT. */
export async function isSttConfigured(): Promise<boolean> { return Boolean(config.stt.apiUrl && config.stt.apiKey) || Boolean(await getGroqSttConfig()); }
function getAudioFormat(filename: string): string { const extension = (filename.split(".").pop() || "").toLowerCase(); return AUDIO_FORMAT_BY_EXTENSION[extension] || "ogg"; }

export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<SttResult> {
  const custom = await getGroqSttConfig();
  const apiUrl = custom?.apiUrl || config.stt.apiUrl;
  const apiKey = custom?.apiKey || config.stt.apiKey;
  const model = custom?.model || config.stt.model;
  if (!apiUrl || !apiKey) throw new Error("STT is not configured. Open Custom Providers and configure Groq Voice STT.");

  const url = `${apiUrl.replace(/\/$/, "")}/audio/transcriptions`;
  const useJsonFormat = config.stt.requestFormat === "json" && !custom;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  let body: FormData | string;
  // Groq is a dedicated STT provider. Its output is only transcription text;
  // it must never replace or configure the OpenCode coding model.
  const language = custom ? GROQ_PERSIAN_LANGUAGE : config.stt.language;
  const prompt = custom ? GROQ_PERSIAN_PROMPT : undefined;

  if (useJsonFormat) {
    const payload: Record<string, unknown> = { model, input_audio: { data: Buffer.from(audioBuffer).toString("base64"), format: getAudioFormat(filename) } };
    if (language) payload.language = language;
    headers["Content-Type"] = "application/json"; body = JSON.stringify(payload);
  } else {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(audioBuffer)]), filename);
    formData.append("model", model);
    formData.append("response_format", "json");
    if (language) formData.append("language", language);
    if (prompt) formData.append("prompt", prompt);
    formData.append("temperature", "0");
    body = formData;
  }

  logger.debug(`[STT] Transcription request: provider=${custom ? "groq-custom" : "env"}, model=${model}, format=${getAudioFormat(filename)}, size=${audioBuffer.length} bytes, language=${language || "auto"}, prompt=${prompt ? "persian-context" : "none"}`);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), STT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!response.ok) { const errorBody = await response.text().catch(() => ""); throw new Error(`STT API returned HTTP ${response.status}: ${errorBody || response.statusText}`); }
    const data = (await response.json()) as { text?: string };
    if (typeof data.text !== "string") throw new Error("STT API response does not contain a text field");
    logger.info(`[STT] Transcription completed: provider=${custom ? "groq-custom" : "env"}, model=${model}, language=${language || "auto"}, chars=${data.text.length}`);
    return { text: data.text };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw new Error(`STT request timed out after ${STT_REQUEST_TIMEOUT_MS}ms`);
    throw err;
  } finally { clearTimeout(timeout); }
}

import { config } from "../../config.js";
import { getGroqSttConfig } from "./custom-provider-service.js";
import { assessTranscription } from "./stt-quality.js";
import { logger } from "../../utils/logger.js";

const STT_REQUEST_TIMEOUT_MS = 60_000;
export interface SttResult {
  text: string;
  uncertain?: boolean;
}
const AUDIO_FORMAT_BY_EXTENSION: Record<string, string> = {
  oga: "ogg",
  ogg: "ogg",
  mp3: "mp3",
  wav: "wav",
  m4a: "m4a",
  flac: "flac",
  aac: "aac",
  webm: "webm",
};
/** STT can be configured by env for backwards compatibility or via Custom Providers > Groq Voice STT. */
export async function isSttConfigured(): Promise<boolean> {
  return Boolean(config.stt.apiUrl && config.stt.apiKey) || Boolean(await getGroqSttConfig());
}
function getAudioFormat(filename: string): string {
  const extension = (filename.split(".").pop() || "").toLowerCase();
  return AUDIO_FORMAT_BY_EXTENSION[extension] || "ogg";
}

export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<SttResult> {
  const custom = await getGroqSttConfig();
  const apiUrl = custom?.apiUrl || config.stt.apiUrl;
  const apiKey = custom?.apiKey || config.stt.apiKey;
  const model = custom?.model || config.stt.model;
  if (!apiUrl || !apiKey)
    throw new Error("STT is not configured. Open Custom Providers and configure Groq Voice STT.");

  const url = `${apiUrl.replace(/\/$/, "")}/audio/transcriptions`;
  const useJsonFormat = config.stt.requestFormat === "json" && !custom;
  // Groq is a dedicated STT provider. Its output is only transcription text;
  // it must never replace or configure the OpenCode coding model.
  const language = config.stt.language || (custom ? "fa" : "");
  const isGroq = new URL(apiUrl).hostname === "api.groq.com";
  if (!audioBuffer.length) return { text: "" };

  const request = async (requestLanguage: string): Promise<SttResult> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    let body: FormData | string;
    if (useJsonFormat) {
      const payload: Record<string, unknown> = {
        model,
        input_audio: {
          data: Buffer.from(audioBuffer).toString("base64"),
          format: getAudioFormat(filename),
        },
      };
      if (requestLanguage) payload.language = requestLanguage;
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    } else {
      const formData = new FormData();
      formData.append("file", new Blob([new Uint8Array(audioBuffer)]), filename);
      formData.append("model", model);
      formData.append("response_format", isGroq ? "verbose_json" : "json");
      if (requestLanguage) formData.append("language", requestLanguage);
      formData.append("temperature", "0");
      body = formData;
    }

    logger.debug(
      `[STT] Transcription request: provider=${custom ? "groq-custom" : "env"}, model=${model}, format=${getAudioFormat(filename)}, size=${audioBuffer.length} bytes, language=${requestLanguage || "auto"}, prompt=none`,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STT_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`STT API returned HTTP ${response.status}`);
      }
      const data = (await response.json()) as { text?: string; segments?: unknown };
      if (typeof data.text !== "string")
        throw new Error("STT API response does not contain a text field");
      const result = isGroq ? assessTranscription(data.text, data.segments) : { text: data.text };
      logger.info(
        `[STT] Transcription completed: provider=${custom ? "groq-custom" : "env"}, model=${model}, language=${requestLanguage || "auto"}, chars=${result.text.length}, uncertain=${Boolean(result.uncertain)}`,
      );
      return result;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError")
        throw new Error(`STT request timed out after ${STT_REQUEST_TIMEOUT_MS}ms`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  };

  // Retry only a flagged result, with a different language assumption. Never
  // promote a failed retry or silently drop uncertain parts of a command.
  const first = await request(language);
  if (!isGroq || !first.uncertain || !language) return first;
  logger.info("[STT] Retrying uncertain transcription with automatic language detection");
  try {
    const retry = await request("");
    return retry.text && !retry.uncertain ? retry : first;
  } catch {
    logger.warn("[STT] Quality retry failed; retaining the uncertain transcript");
    return first;
  }
}

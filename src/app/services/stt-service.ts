import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const STT_REQUEST_TIMEOUT_MS = 60_000;

export interface SttResult {
  text: string;
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

/**
 * Returns true if STT is configured (API URL and API key are set).
 */
export function isSttConfigured(): boolean {
  return Boolean(config.stt.apiUrl && config.stt.apiKey);
}

function getAudioFormat(filename: string): string {
  const extension = (filename.split(".").pop() || "").toLowerCase();
  return AUDIO_FORMAT_BY_EXTENSION[extension] || "ogg";
}

/**
 * Transcribes an audio buffer using a Whisper-compatible API.
 *
 * Language is intentionally omitted unless explicitly configured. This lets
 * Whisper perform automatic language detection for multilingual voice notes.
 *
 * Two request formats are supported via `STT_REQUEST_FORMAT`:
 * - `multipart` (default): standard OpenAI/Groq `multipart/form-data` upload.
 * - `json`: base64 audio in an `input_audio` JSON body (e.g. OpenRouter).
 */
export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<SttResult> {
  if (!isSttConfigured()) {
    throw new Error("STT is not configured: STT_API_URL and STT_API_KEY are required");
  }

  const url = `${config.stt.apiUrl}/audio/transcriptions`;
  const useJsonFormat = config.stt.requestFormat === "json";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.stt.apiKey}`,
  };
  let body: FormData | string;

  if (useJsonFormat) {
    const payload: Record<string, unknown> = {
      model: config.stt.model,
      input_audio: {
        data: Buffer.from(audioBuffer).toString("base64"),
        format: getAudioFormat(filename),
      },
    };

    // Leave language unset by default so the provider can auto-detect it.
    // If STT_LANGUAGE is explicitly configured, honor that override.
    if (config.stt.language) {
      payload.language = config.stt.language;
    }

    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);

    logger.debug(
      `[STT] Sending transcription request (json): url=${url}, model=${config.stt.model}, format=${getAudioFormat(filename)}, size=${audioBuffer.length} bytes, language=${config.stt.language || "auto"}`,
    );
  } else {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(audioBuffer)]), filename);
    formData.append("model", config.stt.model);
    formData.append("response_format", "json");

    // Leave language unset by default so the provider can auto-detect it.
    // If STT_LANGUAGE is explicitly configured, honor that override.
    if (config.stt.language) {
      formData.append("language", config.stt.language);
    }

    body = formData;

    logger.debug(
      `[STT] Sending transcription request (multipart): url=${url}, model=${config.stt.model}, filename=${filename}, size=${audioBuffer.length} bytes, language=${config.stt.language || "auto"}`,
    );
  }

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
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `STT API returned HTTP ${response.status}: ${errorBody || response.statusText}`,
      );
    }

    const data = (await response.json()) as { text?: string };

    if (typeof data.text !== "string") {
      throw new Error("STT API response does not contain a text field");
    }

    logger.debug(`[STT] Transcription result: ${data.text.length} chars`);

    return { text: data.text };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`STT request timed out after ${STT_REQUEST_TIMEOUT_MS}ms`);
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

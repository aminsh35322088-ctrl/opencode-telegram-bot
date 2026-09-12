/** Whisper's upstream fallback thresholds; these are signals, not accuracy scores. */
export function assessTranscription(
  text: string,
  segments: unknown,
): { text: string; uncertain?: boolean } {
  if (!text.trim()) return { text: "" };
  if (!Array.isArray(segments) || !segments.length) return { text, uncertain: true };
  let silent = 0;
  let uncertain = false;
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") {
      uncertain = true;
      continue;
    }
    const {
      avg_logprob: confidence,
      no_speech_prob: noSpeech,
      compression_ratio: compression,
    } = segment;
    if (
      !Number.isFinite(confidence) ||
      !Number.isFinite(noSpeech) ||
      !Number.isFinite(compression)
    ) {
      uncertain = true;
      continue;
    }
    if (noSpeech > 0.6 && confidence < -1) silent++;
    if (confidence < -1 || compression > 2.4) uncertain = true;
  }
  // Never execute only the surviving fragments of a partly unclear command.
  if (silent === segments.length) return { text: "" };
  return uncertain ? { text, uncertain: true } : { text };
}

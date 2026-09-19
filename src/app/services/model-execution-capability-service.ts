import type { CapabilityConfidence, CapabilityDetectionSource, CapabilityState, ModelExecutionCapabilities } from "../types/model-capability.js";

export interface ModelExecutionDetection {
  execution: ModelExecutionCapabilities;
  detection: { source: CapabilityDetectionSource; confidence: CapabilityConfidence };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function bool(...values: unknown[]): CapabilityState {
  for (const value of values) if (typeof value === "boolean") return value;
  return "unknown";
}

function stringList(...values: unknown[]): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.startsWith("audio/"));
    if (items.length) return [...new Set(items)];
  }
  return [];
}

/**
 * Detect executable media transport support separately from model modalities.
 *
 * Important: model.capabilities.input.audio only describes the model. It does NOT prove
 * that the selected OpenCode/AI-SDK provider surface can lower an audio FilePart.
 * Therefore native audio is fail-closed unless the transport contract explicitly says
 * both that native audio FileParts are supported and which MIME types are accepted.
 */
export function detectModelExecutionCapabilities(metadataValue: unknown): ModelExecutionDetection {
  const metadata = record(metadataValue) ?? {};
  const execution = record(metadata.execution);
  const transport = record(metadata.transport);
  const capabilities = record(metadata.capabilities);

  const declared = bool(
    execution?.nativeAudioFileInput,
    execution?.native_audio_file_input,
    transport?.nativeAudioFileInput,
    transport?.native_audio_file_input,
    capabilities?.nativeAudioFileInput,
    capabilities?.native_audio_file_input,
    metadata.nativeAudioFileInput,
    metadata.native_audio_file_input,
  );
  const mimeTypes = stringList(
    execution?.nativeAudioMimeTypes,
    execution?.native_audio_mime_types,
    transport?.nativeAudioMimeTypes,
    transport?.native_audio_mime_types,
    capabilities?.nativeAudioMimeTypes,
    capabilities?.native_audio_mime_types,
    metadata.nativeAudioMimeTypes,
    metadata.native_audio_mime_types,
  );

  if (declared === false) {
    return { execution: { nativeAudioFileInput: false, nativeAudioMimeTypes: [] }, detection: { source: "adapter", confidence: "high" } };
  }
  if (declared === true && mimeTypes.length) {
    return { execution: { nativeAudioFileInput: true, nativeAudioMimeTypes: mimeTypes }, detection: { source: "adapter", confidence: "high" } };
  }

  // Never infer transport support from api.npm/provider/model names. OpenCode can use
  // different API surfaces behind the same AI-SDK package, and their media support differs.
  return { execution: { nativeAudioFileInput: "unknown", nativeAudioMimeTypes: [] }, detection: { source: "adapter", confidence: "low" } };
}

export function nativeAudioTransportAccepts(execution: ModelExecutionCapabilities, mimeType: string): boolean {
  if (execution.nativeAudioFileInput !== true) return false;
  const normalized = mimeType.trim().toLowerCase();
  return execution.nativeAudioMimeTypes.includes(normalized)
    || (normalized.startsWith("audio/") && execution.nativeAudioMimeTypes.includes("audio/*"));
}
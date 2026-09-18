import type {
  CapabilityConfidence,
  CapabilityDetectionSource,
  CapabilityState,
  ModelModality,
  UnifiedModelCapabilities,
} from "../types/model-capability.js";

const MODALITIES: readonly ModelModality[] = ["text", "image", "audio", "video", "pdf"];

type DetectionOptions = {
  source?: CapabilityDetectionSource;
  confidence?: CapabilityConfidence;
  forceSpeechToText?: boolean;
  forceTextToSpeech?: boolean;
  forceImageGenerate?: boolean;
  forceImageEdit?: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizedList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase());
  return values.length ? values : undefined;
}

function explicitBoolean(...values: unknown[]): CapabilityState {
  for (const value of values) if (typeof value === "boolean") return value;
  return "unknown";
}

function modalityState(metadata: Record<string, unknown>, direction: "input" | "output", modality: ModelModality): CapabilityState {
  const modalities = record(metadata.modalities);
  const directList = normalizedList(modalities?.[direction]);
  if (directList) return directList.includes(modality);

  const snakeList = normalizedList(metadata[direction === "input" ? "input_modalities" : "output_modalities"]);
  if (snakeList) return snakeList.includes(modality);

  const architecture = record(metadata.architecture);
  const architectureList = normalizedList(architecture?.[direction === "input" ? "input_modalities" : "output_modalities"]);
  if (architectureList) return architectureList.includes(modality);

  const capabilities = record(metadata.capabilities);
  const capabilityList = normalizedList(capabilities?.[direction]);
  if (capabilityList) return capabilityList.includes(modality);
  const directionFlags = record(capabilities?.[direction]);
  const flag = directionFlags?.[modality];
  return typeof flag === "boolean" ? flag : "unknown";
}

function operationFlag(metadata: Record<string, unknown>, names: string[]): CapabilityState {
  const capabilities = record(metadata.capabilities);
  const operations = record(metadata.operations);
  return explicitBoolean(
    ...names.flatMap((name) => [metadata[name], capabilities?.[name], operations?.[name]]),
  );
}

function and(left: CapabilityState, right: CapabilityState): CapabilityState {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return "unknown";
}

export function detectModelCapabilities(metadataValue: unknown, options: DetectionOptions = {}): {
  capabilities: UnifiedModelCapabilities;
  detection: { source: CapabilityDetectionSource; confidence: CapabilityConfidence };
} {
  const metadata = record(metadataValue) ?? {};
  const input = Object.fromEntries(MODALITIES.map((kind) => [kind, modalityState(metadata, "input", kind)])) as Record<ModelModality, CapabilityState>;
  const output = Object.fromEntries(MODALITIES.map((kind) => [kind, modalityState(metadata, "output", kind)])) as Record<ModelModality, CapabilityState>;

  const explicitStt = options.forceSpeechToText === true ? true : operationFlag(metadata, ["speechToText", "speech_to_text", "transcription", "transcribe"]);
  const explicitTts = options.forceTextToSpeech === true ? true : operationFlag(metadata, ["textToSpeech", "text_to_speech", "speechGeneration", "speech_generation"]);
  const imageGenerate = options.forceImageGenerate === true ? true : output.image;
  const imageEdit = options.forceImageEdit === true ? true : and(imageGenerate, input.image);
  const chat = output.text;

  const capabilitiesRecord = record(metadata.capabilities);
  const toolCalling = explicitBoolean(capabilitiesRecord?.tools, capabilitiesRecord?.toolcall, capabilitiesRecord?.tool_call, metadata.tools, metadata.toolcall, metadata.tool_call);
  const reasoning = explicitBoolean(capabilitiesRecord?.reasoning, metadata.reasoning);
  const structuredOutput = explicitBoolean(capabilitiesRecord?.structuredOutput, capabilitiesRecord?.structured_output, metadata.structured_output);

  const capabilities: UnifiedModelCapabilities = {
    modalities: { input, output },
    operations: {
      chat,
      imageGenerate,
      imageEdit,
      speechToText: explicitStt,
      textToSpeech: explicitTts,
      videoGenerate: output.video,
      embeddings: operationFlag(metadata, ["embeddings", "embedding"]),
    },
    agent: { toolCalling, reasoning, structuredOutput },
    traits: { codingOptimized: operationFlag(metadata, ["codingOptimized", "coding_optimized"]) },
  };

  const hasExplicitMetadata = MODALITIES.some((kind) => input[kind] !== "unknown" || output[kind] !== "unknown")
    || [toolCalling, reasoning, structuredOutput, explicitStt, explicitTts].some((value) => value !== "unknown");
  return {
    capabilities,
    detection: {
      source: options.source ?? (hasExplicitMetadata ? "provider-metadata" : "heuristic"),
      confidence: options.confidence ?? (hasExplicitMetadata ? "high" : "low"),
    },
  };
}

export function capabilityIsSupported(state: CapabilityState): boolean {
  return state === true;
}
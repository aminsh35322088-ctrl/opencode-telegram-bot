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
  modelID?: string;
  modelName?: string;
  forceSpeechToText?: boolean;
  forceTextToSpeech?: boolean;
  forceImageGenerate?: boolean;
  forceImageEdit?: boolean;
  forceVideoGenerate?: boolean;
};

export interface InferredModelModalities {
  input: string[];
  output: string[];
}

interface IdentityCapabilities {
  imageGenerate: boolean;
  speechToText: boolean;
  textToSpeech: boolean;
  videoGenerate: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return values.length ? values : undefined;
}

export function parseModalityTransition(value: unknown): InferredModelModalities | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.toLowerCase().split(/\s*->\s*/u);
  if (match.length !== 2) return undefined;
  const parseSide = (side: string): string[] => [...new Set(side
    .split(/[\s,+/|]+/u)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => MODALITIES.includes(item as ModelModality)))];
  const input = parseSide(match[0]!);
  const output = parseSide(match[1]!);
  return input.length && output.length ? { input, output } : undefined;
}

function explicitBoolean(...values: unknown[]): CapabilityState {
  for (const value of values) if (typeof value === "boolean") return value;
  return "unknown";
}

function modalityState(
  metadata: Record<string, unknown>,
  direction: "input" | "output",
  modality: ModelModality,
): CapabilityState {
  const modalities = record(metadata.modalities);
  const directList = normalizedList(modalities?.[direction]);
  if (directList) return directList.includes(modality);

  const snakeList = normalizedList(metadata[direction === "input" ? "input_modalities" : "output_modalities"]);
  if (snakeList) return snakeList.includes(modality);

  const architecture = record(metadata.architecture);
  const architectureList = normalizedList(architecture?.[direction === "input" ? "input_modalities" : "output_modalities"]);
  if (architectureList) return architectureList.includes(modality);

  const transition = parseModalityTransition(architecture?.modality ?? metadata.modality);
  const transitionList = transition?.[direction];
  if (transitionList) return transitionList.includes(modality);

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

function identityCapabilities(modelID: string, modelName: string): IdentityCapabilities {
  const identity = `${modelID} ${modelName}`.toLowerCase();
  return {
    imageGenerate: /(?:dall[-_. ]?e|gpt[-_. ]?image|image[-_. ]?(?:gen|generation|generator)|(?:gen|generate)[-_. ]?image|stable[-_. ]?diffusion|sdxl|sd3(?:[-_. ]|$)|flux(?:[._-]|\b)|imagen(?:[-_. ]|$)|ideogram|recraft|pixart|kandinsky|dreamshaper|kolors|qwen[-_. ]?image|z[-_. ]?image|seedream|nano[-_. ]?banana|playground(?:[-_. ]|$)|hidream|auraflow|midjourney)/u.test(identity),
    videoGenerate: /(?:sora(?:[-_. ]|$)|veo(?:[-_. ]|$)|kling(?:[-_. ]|$)|runway(?:[-_. ]|$)|luma[-_. ]?dream|pika(?:[-_. ]|$)|wan[-_. ]?\d|hunyuan[-_. ]?video|cogvideo|seedance|vidu(?:[-_. ]|$)|hailuo|mochi[-_. ]?video|video[-_. ]?(?:gen|generation|generator|\d{1,2})|(?:gen|generate)[-_. ]?video)/u.test(identity),
    speechToText: /(?:whisper|parakeet|canary|scribe|voxtral|transcri(?:ption|ber|be)|(?:speech|audio)[-_. ]?(?:to[-_. ]?text|transcri(?:ption|ber|be))|(?:^|[-_. ])stt(?:[-_. ]|$))/u.test(identity),
    textToSpeech: /(?:text[-_. ]?to[-_. ]?speech|(?:^|[-_. ])tts(?:[-_. ]|$)|speech[-_. ]?synth|kokoro|orpheus|fish[-_. ]?speech|eleven[-_. ]?labs|playht|cartesia|bark(?:[-_. ]|$)|dia[-_. ]?\d|audio[-_. ]?(?:gen|generation))/u.test(identity),
  };
}

/**
 * Conservative identity fallback for OpenAI-compatible /models endpoints that
 * return only `id`/`name` and omit modality metadata. Provider-supplied modality
 * declarations always take precedence over this heuristic.
 */
export function inferModelModalitiesFromIdentity(
  modelID: string,
  modelName = modelID,
): InferredModelModalities | undefined {
  const identity = identityCapabilities(modelID, modelName);
  if (identity.speechToText) return { input: ["audio"], output: ["text"] };
  if (identity.textToSpeech) return { input: ["text"], output: ["audio"] };
  if (identity.videoGenerate) return { input: ["text"], output: ["video"] };
  if (identity.imageGenerate) return { input: ["text"], output: ["image"] };
  return undefined;
}

export function detectModelCapabilities(metadataValue: unknown, options: DetectionOptions = {}): {
  capabilities: UnifiedModelCapabilities;
  detection: { source: CapabilityDetectionSource; confidence: CapabilityConfidence };
} {
  const metadata = record(metadataValue) ?? {};
  const modelID = options.modelID ?? (typeof metadata.id === "string" ? metadata.id : typeof metadata.model_id === "string" ? metadata.model_id : "");
  const modelName = options.modelName ?? (typeof metadata.name === "string" ? metadata.name : modelID);
  const identity = identityCapabilities(modelID, modelName);
  const inferred = inferModelModalitiesFromIdentity(modelID, modelName);

  const input = Object.fromEntries(MODALITIES.map((kind) => [kind, modalityState(metadata, "input", kind)])) as Record<ModelModality, CapabilityState>;
  const output = Object.fromEntries(MODALITIES.map((kind) => [kind, modalityState(metadata, "output", kind)])) as Record<ModelModality, CapabilityState>;
  const explicitMetadataStates = [...MODALITIES.map((kind) => input[kind]), ...MODALITIES.map((kind) => output[kind])];

  for (const kind of MODALITIES) {
    if (input[kind] === "unknown" && inferred?.input.includes(kind)) input[kind] = true;
    if (output[kind] === "unknown" && inferred?.output.includes(kind)) output[kind] = true;
  }
  // Recognized media-only model families should not be offered as Coding AI
  // merely because their /models endpoint omits output modalities.
  const inferredMediaOnly = inferred !== undefined;
  if (inferredMediaOnly && output.text === "unknown") output.text = false;
  if (inferredMediaOnly && output.image === "unknown" && identity.imageGenerate) output.image = true;
  if (inferredMediaOnly && output.video === "unknown" && identity.videoGenerate) output.video = true;

  const capabilitiesRecord = record(metadata.capabilities);
  const taskDescription = [metadata.task, metadata.type, metadata.pipeline_tag, metadata.model_type]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const taskIsStt = /(?:transcri(?:ption|ber|be)|speech[-_ ]?to[-_ ]?text|automatic[-_ ]?speech[-_ ]?recognition|\basr\b)/u.test(taskDescription);
  const taskIsTts = /(?:text[-_ ]?to[-_ ]?speech|speech[-_ ]?synth|\btts\b)/u.test(taskDescription);
  const explicitStt = options.forceSpeechToText === true
    ? true
    : operationFlag(metadata, ["speechToText", "speech_to_text", "transcription", "transcribe", "supports_transcription"]);
  // Audio input + text output can also describe an audio-understanding chat
  // model. Do not label it STT unless the provider/task metadata or its model
  // identity confirms transcription specifically.
  const speechToText = explicitStt !== "unknown"
    ? explicitStt
    : identity.speechToText || taskIsStt
      ? true
      : "unknown";

  const explicitTts = options.forceTextToSpeech === true
    ? true
    : operationFlag(metadata, ["textToSpeech", "text_to_speech", "speechGeneration", "speech_generation", "supports_tts"]);
  const textToSpeech = explicitTts !== "unknown"
    ? explicitTts
    : identity.textToSpeech || taskIsTts
      ? true
      : "unknown";

  const explicitChat = operationFlag(metadata, ["chat", "chatCompletion", "chat_completion", "textGeneration", "text_generation"]);
  let chat = explicitChat !== "unknown" ? explicitChat : output.text;
  // Audio-in/text-out models without text input are transcription-first, not
  // general coding chat, unless the provider explicitly reports chat support.
  if (explicitChat === "unknown" && input.audio === true && input.text !== true && speechToText === true) chat = false;

  const explicitImageGenerate = operationFlag(metadata, ["imageGenerate", "image_generate", "imageGeneration", "image_generation", "supports_image_generation"]);
  const imageGenerate = options.forceImageGenerate === true
    ? true
    : explicitImageGenerate !== "unknown"
      ? explicitImageGenerate
      : output.image;
  const explicitImageEdit = operationFlag(metadata, ["imageEdit", "image_edit", "imageEditing", "image_editing"]);
  const imageEdit = options.forceImageEdit === true
    ? true
    : explicitImageEdit !== "unknown"
      ? explicitImageEdit
      : and(imageGenerate, input.image);

  const explicitVideoGenerate = operationFlag(metadata, ["videoGenerate", "video_generate", "videoGeneration", "video_generation", "supports_video_generation"]);
  const videoGenerate = options.forceVideoGenerate === true
    ? true
    : explicitVideoGenerate !== "unknown"
      ? explicitVideoGenerate
      : output.video;

  const toolCalling = explicitBoolean(
    capabilitiesRecord?.tools,
    capabilitiesRecord?.toolcall,
    capabilitiesRecord?.tool_call,
    capabilitiesRecord?.toolCall,
    metadata.tools,
    metadata.toolcall,
    metadata.tool_call,
    metadata.toolCall,
  );
  const reasoning = explicitBoolean(capabilitiesRecord?.reasoning, metadata.reasoning);
  const structuredOutput = explicitBoolean(capabilitiesRecord?.structuredOutput, capabilitiesRecord?.structured_output, metadata.structured_output);

  const capabilities: UnifiedModelCapabilities = {
    modalities: { input, output },
    operations: {
      chat,
      imageGenerate,
      imageEdit,
      speechToText,
      textToSpeech,
      videoGenerate,
      embeddings: operationFlag(metadata, ["embeddings", "embedding"]),
    },
    agent: { toolCalling, reasoning, structuredOutput },
    traits: { codingOptimized: operationFlag(metadata, ["codingOptimized", "coding_optimized"]) },
  };

  const hasExplicitMetadata = explicitMetadataStates.some((value) => value !== "unknown")
    || [explicitChat, explicitStt, explicitTts, explicitImageGenerate, explicitImageEdit, explicitVideoGenerate, toolCalling, reasoning, structuredOutput].some((value) => value !== "unknown");
  const source = options.source === "adapter" || options.source === "manual" || options.source === "endpoint"
    ? options.source
    : hasExplicitMetadata
      ? options.source ?? "provider-metadata"
      : "heuristic";
  return {
    capabilities,
    detection: {
      source,
      confidence: options.confidence ?? (hasExplicitMetadata ? "high" : inferredMediaOnly ? "medium" : "low"),
    },
  };
}

export function capabilityIsSupported(state: CapabilityState): boolean {
  return state === true;
}

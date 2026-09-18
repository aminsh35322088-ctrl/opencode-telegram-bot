type ModelMetadata = {
  modalities?: { input?: string[]; output?: string[] };
  capabilities?: {
    input?: Record<string, boolean>;
    output?: Record<string, boolean>;
    toolcall?: boolean;
  };
  input_modalities?: string[];
  output_modalities?: string[];
};

function metadata(value: unknown): ModelMetadata | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ModelMetadata
    : null;
}

function modalityList(model: ModelMetadata, direction: "input" | "output"): string[] | undefined {
  return model.modalities?.[direction]
    ?? model[direction === "input" ? "input_modalities" : "output_modalities"];
}

export function hasModelInput(metadataValue: unknown, kind: "text" | "image" | "audio" | "video" | "pdf"): boolean {
  const model = metadata(metadataValue);
  if (!model) return false;
  const list = modalityList(model, "input");
  if (Array.isArray(list)) return list.includes(kind);
  return model.capabilities?.input?.[kind] === true;
}

export function hasModelOutput(metadataValue: unknown, kind: "text" | "image" | "audio" | "video" | "pdf"): boolean {
  const model = metadata(metadataValue);
  if (!model) return false;
  const list = modalityList(model, "output");
  if (Array.isArray(list)) return list.includes(kind);
  return model.capabilities?.output?.[kind] === true;
}

/** Image generation is exposed only when the provider explicitly advertises image output. */
export function isImageModelMetadata(metadataValue: unknown): boolean {
  return hasModelOutput(metadataValue, "image");
}

/** Image editing additionally requires the selected model to accept image input. */
export function isImageEditModelMetadata(metadataValue: unknown): boolean {
  return isImageModelMetadata(metadataValue) && hasModelInput(metadataValue, "image");
}

/** Output images/audio/video are excluded from the conversational Chat/Coding Model Center. */
export function isChatModelMetadata(metadataValue: unknown): boolean {
  const model = metadata(metadataValue);
  if (!model) return true;

  const output = modalityList(model, "output");
  if (Array.isArray(output)) {
    return output.includes("text")
      && !output.some((kind) => kind === "image" || kind === "audio" || kind === "video");
  }

  const flags = model.capabilities?.output;
  if (flags) {
    return flags.text === true && !flags.image && !flags.audio && !flags.video;
  }

  // Missing output metadata is common in older/OpenAI-compatible catalogs.
  // Preserve Chat eligibility, but image detection remains explicit-only.
  return true;
}
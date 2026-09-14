/** Output images/audio are never exported as OpenCode agent models, even if text is also supported. */
export function isChatModelMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return true; // Legacy explicitly configured chat model.
  const model = metadata as { modalities?: { output?: string[] }; capabilities?: { output?: Record<string, boolean>; toolcall?: boolean }; output_modalities?: string[] };
  const output = model.modalities?.output ?? model.output_modalities;
  if (Array.isArray(output)) return output.includes("text") && !output.some((kind) => kind === "image" || kind === "audio" || kind === "video");
  const flags = model.capabilities?.output;
  return !flags || (flags.text === true && !flags.image && !flags.audio && !flags.video);
}

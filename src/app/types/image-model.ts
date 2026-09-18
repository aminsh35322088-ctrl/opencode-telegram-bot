export interface ImageModelSelection {
  providerID: string;
  modelID: string;
  editModelID?: string;
}

export function isImageModelSelection(value: unknown): value is ImageModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Partial<ImageModelSelection>;
  if (typeof selection.providerID !== "string" || !selection.providerID.trim()) return false;
  if (typeof selection.modelID !== "string" || !selection.modelID.trim()) return false;
  return selection.editModelID === undefined
    || (typeof selection.editModelID === "string" && Boolean(selection.editModelID.trim()));
}

export function cloneImageModelSelection(
  selection: ImageModelSelection | undefined,
): ImageModelSelection | undefined {
  if (!selection) return undefined;
  return {
    providerID: selection.providerID,
    modelID: selection.modelID,
    ...(selection.editModelID ? { editModelID: selection.editModelID } : {}),
  };
}

export function normalizeImageModelSelection(value: unknown): ImageModelSelection | undefined {
  return isImageModelSelection(value) ? cloneImageModelSelection(value) : undefined;
}

export interface ImageBinary {
  buffer: Buffer;
  mimeType: string;
}

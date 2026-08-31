export type MultimodalRoute = "coding" | "image" | "video";
export type MultimodalAction = "generate" | "edit" | "task";
export interface MultimodalDecision { route: MultimodalRoute; action: MultimodalAction; confidence: number; reason: string; }

const IMAGE_TERMS = /(?:تصویر|عکس|image|picture|photo|illustration|wallpaper|poster|thumbnail)/iu;
const IMAGE_GENERATION = /(?:بساز(?:ی|ید|یم|م)?|بکش(?:ی|ید|یم|م)?|ایجاد(?:\s*کن|\s*کنید|\s*کنیم)?|تولید(?:\s*کن|\s*کنید|\s*کنیم)?|جنریت(?:\s*کن|\s*کنید)?|generate|create|draw|make|render|produce)/iu;
const IMAGE_EDIT = /(?:ویرایش|تغییر|حذف|اضافه|جایگزین|پس.?زمینه|بک.?گراند|رتوش|برش|تبدیل|edit|change|modify|remove|replace|add|background|retouch|crop|resize|transform)/iu;
const VIDEO_TERMS = /(?:ویدیو|ویدئو|video|clip|movie|reel|کلیپ|فیلم)/iu;
const VIDEO_ACTION = /(?:بساز|ایجاد|تولید|جنریت|generate|create|make|render|produce|animate|متحرک)/iu;

export function detectMultimodalIntent(text: string, hasImage = false): MultimodalDecision {
  const value = text.trim();
  if (!value) return { route: "coding", action: "task", confidence: 0, reason: "empty" };
  const hasImageTerm = IMAGE_TERMS.test(value);
  const hasImageAction = IMAGE_GENERATION.test(value);
  const hasEditTerm = IMAGE_EDIT.test(value);
  const hasVideoTerm = VIDEO_TERMS.test(value);
  const hasVideoAction = VIDEO_ACTION.test(value);

  if (hasImage && (hasEditTerm || hasImageTerm)) {
    return { route: "image", action: "edit", confidence: 0.99, reason: "image input with image-edit intent" };
  }
  if (hasVideoTerm && hasVideoAction) {
    return { route: "video", action: "generate", confidence: 0.98, reason: "video generation intent" };
  }
  if (hasImageTerm && hasImageAction) {
    return { route: "image", action: "generate", confidence: 0.97, reason: "image generation intent" };
  }
  if (hasImageTerm && hasEditTerm) {
    return { route: "image", action: "edit", confidence: 0.96, reason: "image edit intent" };
  }
  return { route: "coding", action: "task", confidence: 0.55, reason: "no stronger media intent detected" };
}
